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
        "spectra_pending_autofill",
        "course_occurrences",
        "course_passwords",
        "recorded_attendance_sessids"
      ]);

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

      // 4. PAGE: /my/ or /calendar/ (Dashboard & Upcoming Events)
      handleGeneralUpcomingEvents(store);
    } catch (e) {
      console.warn("[Spectra Content] Error initializing in-page attendance:", e);
    }
  }

  /**
   * DOM attendance submission algorithm (Can also be pasted/run in Console directly)
   */
  function submitAttendanceDOM(options = {}) {
    const { password = "" } = options;

    // 1. Select the "Present" radio option
    const presentRadio = Array.from(document.querySelectorAll('label, span, div'))
      .find(el => {
        const txt = el.textContent.trim().toLowerCase();
        return txt === 'present' || txt === 'hadir';
      })
      ?.closest('label')?.querySelector('input[type="radio"]') 
      || Array.from(document.querySelectorAll('input[type="radio"]')).find(r => {
        const id = r.id;
        const lbl = id ? document.querySelector(`label[for="${id}"]`) : null;
        const parentLbl = r.closest('label');
        const txt = `${lbl?.textContent || ""} ${parentLbl?.textContent || ""} ${r.parentElement?.textContent || ""}`.trim().toLowerCase();
        return /present|hadir|^p\b/.test(txt);
      })
      || document.querySelector('input[type="radio"]');

    if (!presentRadio) {
      console.error("[Spectra] Could not find the 'Present' radio button.");
      return { success: false, error: "Could not find the 'Present' radio button." };
    }

    presentRadio.checked = true;
    presentRadio.dispatchEvent(new Event('change', { bubbles: true }));

    // Handle password if present
    const form = presentRadio.closest('form') || document.querySelector('form[action*="attendance.php"], form#mform1');
    const pwdInput = form ? form.querySelector('input[name="studentpassword"], input[name="password"], input[type="password"]') : null;
    if (pwdInput && !pwdInput.value) {
      if (password) {
        pwdInput.value = password;
        pwdInput.dispatchEvent(new Event("input", { bubbles: true }));
        pwdInput.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        pwdInput.focus();
        pwdInput.style.outline = "3px solid #f59e0b";
        return { success: false, requiresPassword: true, error: "Password required to check in." };
      }
    }

    // 2. Click the "Save changes" submit button
    const submitBtn = Array.from(document.querySelectorAll('input[type="submit"], button'))
      .find(btn => btn.value?.includes('Save') || btn.textContent?.includes('Save') || btn.value?.includes('Simpan') || btn.textContent?.includes('Simpan'));

    if (submitBtn) {
      submitBtn.click();
    } else {
      // Fallback: submit the enclosing form directly
      presentRadio.closest('form')?.submit();
    }

    return { success: true };
  }

  // Expose on window for direct Console execution
  window.spectraSubmitAttendance = submitAttendanceDOM;

  function handleAttendanceFormPage(store) {
    console.log("[Spectra Attendance] Active on attendance form page:", window.location.href);

    const sessidMatch = window.location.href.match(/sessid=(\d+)/);
    const sessid = sessidMatch ? sessidMatch[1] : null;

    // Check if attendance is already recorded
    const bodyText = document.body ? document.body.innerText : "";
    if (
      bodyText.includes("Your attendance has been recorded") ||
      bodyText.includes("Kehadiran anda telah direkodkan") ||
      bodyText.includes("Attendance has been recorded")
    ) {
      showSpectraToast("Attendance recorded as Present! ✅", "success");
      chrome.storage.local.remove(["spectra_pending_autofill"]).catch(() => {});
      if (sessid) {
        chrome.runtime.sendMessage({
          action: "RECORD_ATTENDANCE_SUCCESS",
          payload: { sessid, status: "Present" }
        }).catch(() => { });
      }
      return;
    }

    // Find any saved course password
    const pending = store.spectra_pending_autofill;
    let matchedPwd = (pending && pending.password) ? pending.password : "";
    if (!matchedPwd) {
      const passwordsMap = store.course_passwords || {};
      for (const val of Object.values(passwordsMap)) {
        if (val && String(val).trim()) {
          matchedPwd = String(val).trim();
          break;
        }
      }
    }

    showSpectraToast("Spectra auto-filling Present and submitting attendance... ⏳", "info");
    const result = submitAttendanceDOM({ password: matchedPwd });
    if (result.success) {
      if (sessid) {
        chrome.runtime.sendMessage({
          action: "RECORD_ATTENDANCE_SUCCESS",
          payload: { sessid, status: "Present", courseCode: pending?.courseCode }
        }).catch(() => {});
      }
      chrome.storage.local.remove(["spectra_pending_autofill"]).catch(() => {});
    } else if (result.requiresPassword) {
      showSpectraToast("Password required: please enter password and submit.", "warning");
    }
  }

  function handleAttendanceViewPage(store) {
    console.log("[Spectra Attendance] Active on attendance view page:", window.location.href);

    // Check if attendance was just recorded or confirmed on this page
    const bodyText = document.body ? document.body.innerText : "";
    if (
      bodyText.includes("Your attendance has been recorded") ||
      bodyText.includes("Kehadiran anda telah direkodkan") ||
      bodyText.includes("Attendance has been recorded")
    ) {
      showSpectraToast("Attendance recorded as Present! ✅", "success");
      const navItem = sessionStorage.getItem("spectra_attendance_navigation");
      let sessid = null;
      if (navItem) {
        try {
          sessid = JSON.parse(navItem)?.sessid;
        } catch (e) {}
      }
      if (sessid) {
        chrome.runtime.sendMessage({
          action: "RECORD_ATTENDANCE_SUCCESS",
          payload: { sessid, status: "Present" }
        }).catch(() => {});
      }
      chrome.storage.local.remove(["spectra_pending_autofill"]).catch(() => {});
    }
  }

  function handleCourseViewPage(store) {
    // Check if there is an active check-in link without forcibly redirecting the user
    const directAttendanceLinks = document.querySelectorAll('a[href*="/mod/attendance/attendance.php?sessid="]');
    if (directAttendanceLinks.length > 0) {
      console.log("[Spectra Attendance] Active check-in link spotted on course page.");
    }
  }

  function handleGeneralUpcomingEvents(store) {
    // Check for any direct attendance check-in link without forcibly redirecting
    const directLinks = document.querySelectorAll('a[href*="/mod/attendance/attendance.php?sessid="]');
    if (directLinks.length > 0) {
      console.log("[Spectra Attendance] Active check-in link spotted on dashboard.");
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

  function extractAllOccurrenceNumbersContent(text) {
    if (!text) return [];
    const str = String(text).toLowerCase();
    const numbers = new Set();

    const rangeWordRegex = /\b(?:occ(?:urrence)?|kumpulan|kump|group|tut(?:orial)?|lecture\s+group|lec\s+group|kumpulan\s+kuliah)\s*#?\s*0*(\d+)\s*(?:to|hingga|sampai)\s*(?:(?:occ(?:urrence)?|kumpulan|kump|group|tut(?:orial)?|lecture\s+group|lec\s+group|kumpulan\s+kuliah)\s*#?\s*)?0*(\d+)\b/gi;
    let rangeMatch;
    while ((rangeMatch = rangeWordRegex.exec(str)) !== null) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (!isNaN(start) && !isNaN(end) && end >= start && end - start <= 20) {
        for (let n = start; n <= end; n++) numbers.add(n);
      }
    }

    const hyphenRangeRegex = /\b(?:occ(?:urrence)?|kumpulan|kump|group|tut(?:orial)?)\s*#?\s*0*(\d+)\s*-\s*0*(\d+)\b(?!\s*-\s*(?:occ|group|kump|\d))/gi;
    while ((rangeMatch = hyphenRangeRegex.exec(str)) !== null) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (!isNaN(start) && !isNaN(end) && end >= start && end - start <= 20) {
        for (let n = start; n <= end; n++) numbers.add(n);
      }
    }

    const tokenRegex = /(?:\b(?:occ(?:urrence)?|kumpulan|kump|group|tut(?:orial)?|lecture\s+group|lec\s+group|kumpulan\s+kuliah)\s*#?\s*|\b[ktg]\s*#?\s*)0*(\d+)\b/gi;
    let tokenMatch;
    while ((tokenMatch = tokenRegex.exec(str)) !== null) {
      const n = parseInt(tokenMatch[1], 10);
      if (!isNaN(n)) numbers.add(n);
    }

    const listAfterPrefixRegex = /\b(?:occ(?:urrence)?|kumpulan|kump|group|tut(?:orial)?|lecture\s+group|lec\s+group|kumpulan\s+kuliah)\s*#?\s*0*(\d+)(?:\s*[,/&-]\s*0*(\d+))+/gi;
    let listMatch;
    while ((listMatch = listAfterPrefixRegex.exec(str)) !== null) {
      const subDigits = listMatch[0].match(/\b0*(\d+)\b/g);
      if (subDigits) {
        subDigits.forEach((d) => {
          const n = parseInt(d, 10);
          if (!isNaN(n)) numbers.add(n);
        });
      }
    }

    const pureNumMatch = str.trim().match(/^0*(\d+)$/);
    if (pureNumMatch) {
      const n = parseInt(pureNumMatch[1], 10);
      if (!isNaN(n)) numbers.add(n);
    }

    return Array.from(numbers);
  }

  function matchesPageOccurrence(groupText, description, studentOccurrence) {
    const group = String(groupText || "").trim().toLowerCase();
    const occurrence = String(studentOccurrence || "").trim().toLowerCase();
    const detail = String(description || "").toLowerCase().replace(
      /\b(?:tutorial|tut|lab|assignment|tugasan)\s+\d+\s+(?:submission|link|dropbox|box|handin|hantar|due)\b/gi,
      ""
    );
    if (!occurrence || occurrence === "all") return true;

    const universal = !group || group === "all" || group.includes("all students") || group.includes("semua pelajar");

    const studentNumbers = extractAllOccurrenceNumbersContent(occurrence);
    const targetNumbers = !universal ? extractAllOccurrenceNumbersContent(group) : extractAllOccurrenceNumbersContent(detail);

    if (targetNumbers.length > 0) {
      if (studentNumbers.length === 0) return false;
      return studentNumbers.some((n) => targetNumbers.includes(n));
    }

    if (universal) return true;
    return Boolean(occurrence && (group === occurrence || group.includes(occurrence)));
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
