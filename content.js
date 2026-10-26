/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * In-Page Content Script (runs inside https://spectrum.um.edu.my/*)
 *
 * Automatically captures live Moodle session keys, student profile,
 * and acts as an in-page proxy for calendar & coursework requests
 * with 100% native SameSite cookie privileges.
 */

(function () {
  console.log("[Spectra Content] Initialized on SPeCTRUM:", window.location.href);

  // Auto-capture session on page load
  captureLiveSession();

  // Instant in-page auto-attendance and session watcher
  initInPageAttendance();

  // Auto-capture iCal URL if user visits calendar export page
  if (window.location.pathname.includes("/calendar/export")) {
    captureCalendarExportPage();
  }

  // Listen for requests from Spectra popup or background worker
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      const { action, payload } = request || {};

      if (action === "GET_INPAGE_SESSION") {
        const session = captureLiveSession();
        sendResponse({ success: true, data: session });
        return false;
      }

      if (action === "INPAGE_AJAX_CALL") {
        const { endpoint, body } = payload || {};
        fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify(body)
        })
          .then((res) => res.json())
          .then((data) => sendResponse({ success: true, data }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true; // Keep channel open for async response
      }

      if (action === "INPAGE_FETCH_HTML") {
        const { url } = payload || {};
        fetch(url)
          .then((res) => res.text())
          .then((html) => sendResponse({ success: true, html }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }

      if (action === "RUN_SPECTRUM_SCRAPER") {
        const { moodleSession } = payload || {};
        runSpectrumScraperInPage(moodleSession)
          .then((res) => sendResponse({ success: true, data: res }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }

      if (action === "AUTO_DISCOVER_ICAL_URL") {
        discoverIcalUrlInPage()
          .then((url) => sendResponse({ success: true, url }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
      }

      return false;
    });
  }

  function captureCalendarExportPage() {
    try {
      const match = document.body ? document.body.innerHTML.match(/(https?:\/\/[^\s"'<>]+\/calendar\/export_execute\.php\?[^\s"'<>]+)/i) : null;
      if (match) {
        const cleanUrl = match[1].replace(/&amp;/g, "&");
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          chrome.storage.local.set({
            calendarIcalUrl: cleanUrl,
            calendar_ical_url: cleanUrl
          });
          console.log("[Spectra Content] Auto-captured iCal URL from export page:", cleanUrl);
        }
      }
    } catch (e) { }
  }

  async function discoverIcalUrlInPage() {
    const urlRegex = /(https?:\/\/[^\s"'<>]+\/calendar\/export_execute\.php\?[^\s"'<>]+)/i;
    // 1. Check current DOM
    const link = document.querySelector('a[href*="export_execute.php"]');
    if (link && link.href) {
      const url = link.href.replace(/&amp;/g, "&");
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.set({ calendarIcalUrl: url, calendar_ical_url: url });
      }
      return url;
    }

    // 2. Fetch GET export.php in page context
    const getRes = await fetch("https://spectrum.um.edu.my/calendar/export.php");
    const getHtml = await getRes.text();
    const m1 = getHtml.match(urlRegex);
    if (m1) {
      const url = m1[1].replace(/&amp;/g, "&");
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.set({ calendarIcalUrl: url, calendar_ical_url: url });
      }
      return url;
    }

    // 3. Extract sesskey and POST to generateurl
    const mSess = getHtml.match(/name=["']sesskey["'][^>]*value=["']([a-zA-Z0-9]+)["']/i) ||
      (window.M && window.M.cfg && window.M.cfg.sesskey ? [null, window.M.cfg.sesskey] : null);
    const sesskey = mSess ? mSess[1] : "";

    const params = new URLSearchParams();
    if (sesskey) params.set("sesskey", sesskey);
    params.set("_qf__core_calendar_export_form", "1");
    params.set("events[exportevents]", "all");
    params.set("period[timeperiod]", "recentupcoming");
    params.set("generateurl", "Get calendar URL");

    const postRes = await fetch("https://spectrum.um.edu.my/calendar/export.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    const postHtml = await postRes.text();
    const m2 = postHtml.match(urlRegex);
    if (m2) {
      const url = m2[1].replace(/&amp;/g, "&");
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.set({ calendarIcalUrl: url, calendar_ical_url: url });
      }
      return url;
    }

    const uid = postHtml.match(/name=["']userid["'][^>]*value=["'](\d+)["']/i) || postHtml.match(/userid=(\d+)/i);
    const tok = postHtml.match(/name=["']authtoken["'][^>]*value=["']([a-f0-9]{16,})["']/i) || postHtml.match(/authtoken=([a-f0-9]{16,})/i);
    if (uid && tok) {
      const url = `https://spectrum.um.edu.my/calendar/export_execute.php?userid=${uid[1]}&authtoken=${tok[1]}&preset_what=all&preset_time=recentupcoming`;
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        chrome.storage.local.set({ calendarIcalUrl: url, calendar_ical_url: url });
      }
      return url;
    }

    throw new Error("Unable to generate iCal URL from SPeCTRUM calendar page.");
  }

  function captureLiveSession() {
    // 1. Detect if user is logged in
    const bodyText = document.body ? document.body.innerText : "";
    const isGuest = bodyText.includes("You are not logged in") || document.querySelector('input[name="logintoken"]');

    if (isGuest) {
      console.log("[Spectra Content] Guest / unauthenticated state detected.");
      return { authenticated: false };
    }

    // 2. Discover Moodle CSRF sesskey
    let sesskey = null;

    // Check hidden input
    const inputEl = document.querySelector('input[name="sesskey"]');
    if (inputEl && inputEl.value) {
      sesskey = inputEl.value;
    }

    // Check logout links (very reliable in Moodle: /login/logout.php?sesskey=XYZ)
    if (!sesskey) {
      const logoutLink = document.querySelector('a[href*="logout.php?sesskey="]');
      if (logoutLink) {
        const m = logoutLink.href.match(/sesskey=([a-zA-Z0-9]+)/);
        if (m) sesskey = m[1];
      }
    }

    // Check inline scripts
    if (!sesskey) {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const content = s.textContent || "";
        const m = content.match(/"sesskey":"([^"]+)"/) || content.match(/M\.cfg\.sesskey\s*=\s*"([^"]+)"/);
        if (m) {
          sesskey = m[1];
          break;
        }
      }
    }

    // 3. Discover Student Name & Avatar
    let userName = "UM Student";
    let userAvatarUrl = "";

    const userTextEl = document.querySelector(".usertext, .logininfo a, .usermenu .usertext, span.user-name");
    if (userTextEl && userTextEl.textContent.trim()) {
      userName = userTextEl.textContent.trim();
    }

    const avatarEl = document.querySelector(".userpicture, .userbutton img, .avatars img");
    if (avatarEl) {
      userAvatarUrl = avatarEl.getAttribute("src") || "";
    }

    // 4. Discover Enrolled Courses
    const courses = [];
    const seenIds = new Set();
    const courseLinks = document.querySelectorAll('a[href*="course/view.php?id="]');
    courseLinks.forEach((a) => {
      const href = a.href;
      const m = href.match(/id=(\d+)/);
      if (m && m[1] !== "1" && !seenIds.has(m[1])) {
        seenIds.add(m[1]);
        const text = a.textContent.trim();
        if (text && text.length >= 3) {
          const codeMatch = text.match(/\b([A-Z]{3,4}\d{4})\b/i);
          const code = codeMatch ? codeMatch[1].toUpperCase() : "UM";
          courses.push({
            id: m[1],
            code,
            name: text.replace(code, "").replace(/^[\s\-:]+/, "").trim() || text,
            url: href
          });
        }
      }
    });

    const sessionPayload = {
      authenticated: Boolean(sesskey),
      sesskey,
      userName,
      userAvatarUrl,
      courses,
      updatedAt: Date.now()
    };

    if (sesskey && typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({
        spectrum_live_session: sessionPayload,
        moodle_session_valid: true
      });
      console.log("[Spectra Content] Live SPeCTRUM session captured for:", userName);
    }

    return sessionPayload;
  }

  async function runSpectrumScraperInPage(moodleSession) {
    const MOODLE_SESSION = String(moodleSession || "").trim();
    if (!MOODLE_SESSION) {
      return { success: false, error: "A MoodleSession token is required." };
    }

    console.log("%c[1/4] Setting session cookie...", "color: #3b82f6; font-weight: bold;");
    document.cookie = `MoodleSession=${MOODLE_SESSION}; path=/; domain=spectrum.um.edu.my`;
    document.cookie = `MoodleSession=${MOODLE_SESSION}; path=/;`;

    console.log("%c[2/4] Testing dashboard access & extracting sesskey...", "color: #3b82f6; font-weight: bold;");

    let sesskey = null;
    let userName = "Unknown";

    try {
      const dashboardRes = await fetch("https://spectrum.um.edu.my/my/", {
        credentials: "include"
      });

      if (dashboardRes.redirected && dashboardRes.url.includes("login")) {
        throw new Error("REDIRECTED_TO_LOGIN: The provided MoodleSession cookie is invalid or expired.");
      }

      const html = await dashboardRes.text();

      // 1. Extract sesskey (required for Moodle's native JSON APIs)
      const sesskeyMatch = html.match(/"sesskey":"([^"]+)"/);
      if (!sesskeyMatch) {
        throw new Error("Could not parse sesskey from dashboard. Check if session is valid.");
      }
      sesskey = sesskeyMatch[1];

      // 2. Extract logged-in user name
      const userMatch = html.match(/class="usertext[^"]*">([^<]+)<\/span>/i) || html.match(/class="userbutton"[^>]*>.*?<span class="usertext">([^<]+)<\/span>/is);
      if (userMatch) {
        userName = userMatch[1].trim();
      }

      console.log(`%c✔ Session Active! Welcome, ${userName}`, "color: #10b981; font-weight: bold;");
      console.log(`%c✔ Extracted sesskey: ${sesskey}`, "color: #10b981;");

    } catch (err) {
      console.error("%c✖ Session Handshake Failed:", "color: #ef4444; font-weight: bold;", err.message);
      return { success: false, error: err.message };
    }

    // [3/3] Scrape Enrolled Courses
    console.log("%c[3/3] Fetching enrolled courses...", "color: #3b82f6; font-weight: bold;");
    let courses = [];
    let rawCourseData = null;
    try {
      const coursePayload = [{
        index: 0,
        methodname: "core_course_get_enrolled_courses_by_timeline_classification",
        args: {
          classification: "inprogress",
          limit: 0,
          offset: 0,
          sort: "fullname"
        }
      }];

      const courseRes = await fetch(`https://spectrum.um.edu.my/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_enrolled_courses_by_timeline_classification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(coursePayload)
      });

      const [courseData] = await courseRes.json();
      rawCourseData = courseData;

      if (courseData.error) {
        console.warn("Course API returned an error:", courseData.exception);
      } else {
        courses = (courseData.data?.courses || []).map(c => ({
          "ID": c.id,
          "Code": c.shortname,
          "Course Name": c.fullname,
          "URL": c.viewurl
        }));

        console.log("%cEnrolled Courses:", "color: #10b981; font-weight: bold;");
        console.table(courses);
      }
    } catch (err) {
      console.error("Failed to query enrolled courses:", err);
    }

    console.log("%c✔ Scraping logic test complete.", "color: #10b981; font-weight: bold;");

    const payload = {
      success: true,
      sesskey,
      userName,
      events: [],
      courses,
      rawCalendarEvents: [],
      rawCourses: rawCourseData?.data?.courses || []
    };

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.set({
        spectrum_scraped_data: payload,
        verifiedSesskey: sesskey,
        userName,
        sessionStatus: "connected"
      });
    }

    return payload;
  }

  // -------------------------------------------------------------
  // Instant In-Page Auto-Attendance Engine & Live Watcher
  // -------------------------------------------------------------
  async function initInPageAttendance() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    try {
      const store = await chrome.storage.local.get([
        "pref_auto_attendance",
        "course_occurrences",
        "course_passwords",
        "recorded_attendance_sessids"
      ]);

      const isAutoEnabled = store.pref_auto_attendance !== false;
      if (!isAutoEnabled) {
        console.log("[Spectra Content] Auto-attendance paused in user preferences.");
        return;
      }

      const currentUrl = window.location.href;

      // 1. PAGE: /mod/attendance/attendance.php (The check-in form itself)
      if (currentUrl.includes("/mod/attendance/attendance.php")) {
        handleAttendanceFormPage(store);
        return;
      }

      // 2. PAGE: /mod/attendance/view.php (Attendance session records table)
      if (currentUrl.includes("/mod/attendance/view.php")) {
        handleAttendanceViewPage(store);
        return;
      }

      // 3. PAGE: /course/view.php (Course home page)
      if (currentUrl.includes("/course/view.php")) {
        handleCourseViewPage(store);
        return;
      }
    } catch (e) {
      console.warn("[Spectra Content] Error initializing in-page attendance:", e);
    }
  }

  function handleAttendanceFormPage(store) {
    console.log("[Spectra Attendance] Active on attendance form page:", window.location.href);

    const sessidMatch = window.location.href.match(/sessid=(\d+)/);
    let navigationContext = null;
    try {
      navigationContext = JSON.parse(sessionStorage.getItem("spectra_attendance_navigation") || "null");
      sessionStorage.removeItem("spectra_attendance_navigation");
    } catch (_) { }
    if (!navigationContext || navigationContext.sessid !== sessidMatch?.[1] || Date.now() - navigationContext.timestamp > 120000) {
      console.log("[Spectra Attendance] Automatic submission skipped: no recent occurrence-checked navigation.");
      return;
    }

    // Check if attendance is already recorded
    const bodyText = document.body ? document.body.innerText : "";
    if (
      bodyText.includes("Your attendance has been recorded") ||
      bodyText.includes("Kehadiran anda telah direkodkan") ||
      bodyText.includes("Attendance has been recorded")
    ) {
      showSpectraToast("Attendance recorded as Present! ✅", "success");
      if (sessidMatch) {
        chrome.runtime.sendMessage({
          action: "RECORD_ATTENDANCE_SUCCESS",
          payload: { sessid: sessidMatch[1], status: "Present" }
        }).catch(() => { });
      }
      return;
    }

    const form = document.querySelector('form[action*="attendance.php"], form#mform1');
    if (!form) return;

    // Extract sessid
    const sessidInput = form.querySelector('input[name="sessid"]');
    const sessid = sessidInput ? sessidInput.value : (sessidMatch ? sessidMatch[1] : null);

    // Find Present / Hadir radio button
    const radioInputs = form.querySelectorAll('input[name="status"]');
    let presentRadio = null;

    for (const r of radioInputs) {
      const id = r.id;
      const label = id ? document.querySelector(`label[for="${id}"]`) : null;
      const parentLabel = r.closest("label");
      const text = `${label?.textContent || ""} ${parentLabel?.textContent || ""} ${r.parentElement?.textContent || ""}`.trim();
      if (/present|hadir|^p\b/i.test(text)) {
        presentRadio = r;
        break;
      }
    }

    if (!presentRadio && radioInputs.length > 0) {
      presentRadio = radioInputs[0];
    }

    if (!presentRadio) {
      console.warn("[Spectra Attendance] Present option not found in form.");
      return;
    }

    // Select the Present radio button
    presentRadio.checked = true;
    presentRadio.dispatchEvent(new Event("change", { bubbles: true }));
    presentRadio.dispatchEvent(new Event("click", { bubbles: true }));

    // Check password field
    const pwdInput = form.querySelector('input[name="studentpassword"], input[name="password"], input[type="password"]');
    if (pwdInput) {
      const passwordsMap = store.course_passwords || {};
      let matchedPwd = "";
      for (const val of Object.values(passwordsMap)) {
        if (val && String(val).trim()) {
          matchedPwd = String(val).trim();
          break;
        }
      }

      if (matchedPwd) {
        pwdInput.value = matchedPwd;
        pwdInput.dispatchEvent(new Event("input", { bubbles: true }));
        pwdInput.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        pwdInput.focus();
        pwdInput.style.outline = "3px solid #f59e0b";
        showSpectraToast("Password required: please enter password and submit.", "warning");
        return;
      }
    }

    // Find submit button
    const submitBtn = form.querySelector('input[type="submit"], button[type="submit"], input#id_submitbutton');
    if (submitBtn) {
      showSpectraToast("Submitting attendance as Present... ⏳", "info");
      setTimeout(() => {
        submitBtn.click();
      }, 300);
    }
  }

  function handleAttendanceViewPage(store) {
    console.log("[Spectra Attendance] Active on attendance view page:", window.location.href);

    function scanForOpenSessions() {
      const submitLinks = document.querySelectorAll('a[href*="attendance.php?sessid="]');
      if (submitLinks.length === 0) return false;

      const preferredOcc = findPageOccurrence(store);

      for (const link of submitLinks) {
        const row = link.closest("tr");
        const cells = row ? Array.from(row.querySelectorAll("td")) : [];
        const groupText = cells.length >= 6 ? cells[2].innerText.trim() : "";
        const description = cells.length >= 6 ? cells[3].innerText.trim() : (row?.innerText || "");
        const linkText = link.innerText.trim();

        if ((/submit|hantar|rekod/i.test(linkText) || /submit|hantar|rekod/i.test(row?.innerText || "")) &&
          matchesPageOccurrence(groupText, description, preferredOcc)) {
          const sessid = link.href.match(/sessid=(\d+)/)?.[1];
          if (!sessid) continue;
          sessionStorage.setItem("spectra_attendance_navigation", JSON.stringify({ sessid, timestamp: Date.now() }));
          console.log("[Spectra Attendance] Open session detected! Navigating to form:", link.href);
          showSpectraToast("Open attendance session found! Auto-submitting... 🚀", "success");
          window.location.href = link.href;
          return true;
        }
      }
      return false;
    }

    // Check immediately on page load
    const found = scanForOpenSessions();

    // If not found yet, set a gentle 10s poll to watch when lecturer opens it
    if (!found) {
      const watchInterval = setInterval(() => {
        if (scanForOpenSessions()) {
          clearInterval(watchInterval);
        }
      }, 10000);
    }
  }

  function handleCourseViewPage(store) {
    const directAttendanceLinks = document.querySelectorAll('a[href*="/mod/attendance/attendance.php?sessid="]');
    const courseId = new URL(window.location.href).searchParams.get("id") || "";
    const preferredOcc = findPageOccurrence(store, courseId);
    for (const link of directAttendanceLinks) {
      const activity = link.closest("li.activity, .activityinstance, div.activity");
      const description = activity?.innerText || link.innerText;
      if (!matchesPageOccurrence("", description, preferredOcc)) continue;

      const sessid = link.href.match(/sessid=(\d+)/)?.[1];
      if (!sessid) continue;
      console.log("[Spectra Attendance] Matching attendance link found on course page:", link.href);
      showSpectraToast("Active attendance link detected! Auto-navigating... 🚀", "success");
      sessionStorage.setItem("spectra_attendance_navigation", JSON.stringify({ sessid, timestamp: Date.now() }));
      setTimeout(() => {
        window.location.href = link.href;
      }, 500);
      return;
    }
  }

  function findPageOccurrence(store, knownCourseId = "") {
    const occurrences = store.course_occurrences || {};
    if (knownCourseId && occurrences[knownCourseId]) return occurrences[knownCourseId];

    const breadcrumb = document.querySelector("#page-navbar, .breadcrumb, nav[aria-label='Breadcrumb']");
    if (!breadcrumb) return "";
    const courseLinks = breadcrumb.querySelectorAll('a[href*="course/view.php?id="]');
    for (let index = courseLinks.length - 1; index >= 0; index--) {
      const link = courseLinks[index];
      const id = link.href.match(/[?&]id=(\d+)/)?.[1];
      const code = link.textContent.match(/\b[A-Z]{3,4}\s*\d{4}[A-Z]?\b/i)?.[0]?.replace(/\s+/g, "").toUpperCase();
      const occurrence = occurrences[id] || occurrences[code];
      if (occurrence) return occurrence;
    }
    return "";
  }

  function matchesPageOccurrence(groupText, description, studentOccurrence) {
    const group = String(groupText || "").trim().toLowerCase();
    const occurrence = String(studentOccurrence || "").trim().toLowerCase();
    const detail = String(description || "").toLowerCase().replace(
      /\b(?:tutorial|tut|lab|assignment|tugasan)\s+\d+\s+(?:submission|link|dropbox|box|handin|hantar|due)\b/gi,
      ""
    );
    if (occurrence === "all") return true;

    const universal = !group || group === "all" || group.includes("all students") || group.includes("semua pelajar");
    const marker = /\b(?:occ(?:urrence)?|kumpulan|group|tutorial|tut)\s*#?\s*0*(\d+)\b/i;
    const studentNumber = occurrence.match(marker) || occurrence.match(/\b0*(\d+)\b/);
    const target = universal ? detail : group;
    const targetNumber = target.match(marker) || (!universal ? target.match(/^\s*0*(\d+)\s*$/) : null);

    if (universal && !targetNumber) return true;
    if (!studentNumber || !targetNumber) return Boolean(occurrence && !universal && (group === occurrence || group.includes(occurrence)));
    return parseInt(studentNumber[1] || studentNumber[0], 10) === parseInt(targetNumber[1] || targetNumber[0], 10);
  }

  function showSpectraToast(message, type = "info") {
    const existing = document.getElementById("spectra-inpage-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "spectra-inpage-toast";
    const bgColors = {
      success: "#059669",
      warning: "#d97706",
      error: "#dc2626",
      info: "#2563eb"
    };

    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: ${bgColors[type] || bgColors.info};
      color: #ffffff;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.25);
      transition: opacity 0.3s ease, transform 0.3s ease;
      display: flex;
      align-items: center;
      gap: 10px;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      setTimeout(() => toast.remove(), 400);
    }, 4000);
  }
})();
