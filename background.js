/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Background Service Worker (Manifest V3) - Zero-Mock Production
 * Handles cookie synchronization, periodic alarms, cloud relay,
 * live forum announcement polling, and Telegram notification pipeline.
 */

import {
  getSessionContext,
  getLiveEnrolledCourses,
  fetchLiveAnnouncements,
  injectAndScrapeSpectrum,
  setupDeclarativeCookieRule,
  AuthExpiredError
} from "./utils/moodleApi.js";

import { fetchLiveDeadlines } from "./utils/calendar.js";
import { parseForumDiscussions, calculateUrgency, isAttendanceActivity, isOverdueMoreThan40Days, isOverdueMoreThan100Days } from "./utils/parser.js";
import {
  sendTelegramMessage,
  sendTelegramTestMessage,
  formatAnnouncementTelegram,
  formatDeadlineTelegram
} from "./utils/telegram.js";

import {
  fetchCourseAttendance,
  fetchLiveAllAttendance,
  autoSubmitAttendance,
  scanAndAutoRecordAttendance,
  formatAttendanceTelegram
} from "./utils/attendance.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";
const COOKIE_NAME = "MoodleSession";

// -------------------------------------------------------------
// Lifecycle & Alarms Initialization
// -------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Spectra] Live service worker initialized:", details.reason);

  const defaults = {
    telegram_bot_token: "",
    telegram_chat_id: "",
    custom_webhook_url: "",
    cloud_relay_enabled: false,
    cloud_relay_url: "",
    cloud_relay_secret: "",
    poll_interval_mins: 15,
    notify_announcements: true,
    notify_urgent_deadlines: true,
    completed_assignment_ids: [],
    telegram_sent_announcement_ids: [],
    telegram_sent_deadline_ids: [],
    last_sync_timestamp: null,
    semester_start_date: "2026-10-05"
  };

  const stored = await chrome.storage.local.get(Object.keys(defaults));
  await chrome.storage.local.remove(["ntfy_topic", "seen_announcement_ids", "seen_deadline_alert_ids"]);
  const toSet = {};
  for (const [key, val] of Object.entries(defaults)) {
    if (stored[key] === undefined) {
      toSet[key] = val;
    }
  }
  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }

  // Register background alarms
  await setupAlarms(stored.poll_interval_mins || 15);

  // Check active session cookie
  const session = await checkActiveSession();
  if (session.authenticated && session.session?.value) {
    await setupDeclarativeCookieRule(session.session.value);
  }

  // Run initial auto-attendance check
  await checkAutoAttendance();
});

// Browser Startup Listener
chrome.runtime.onStartup.addListener(async () => {
  console.log("[Spectra] Browser started up: refreshing alarms & running attendance check.");
  const stored = await chrome.storage.local.get(["poll_interval_mins"]);
  await setupAlarms(stored.poll_interval_mins || 15);
  const session = await checkActiveSession();
  if (session.authenticated && session.session?.value) {
    await setupDeclarativeCookieRule(session.session.value);
  }
  await checkAutoAttendance();
});

// Tab Navigation Listener (Triggers attendance scan when student opens SPeCTRUM in active tab)
let lastTabAttendanceScan = 0;
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && tab.url.includes("spectrum.um.edu.my")) {
    const now = Date.now();
    // Throttle to at most once every 60 seconds
    if (now - lastTabAttendanceScan > 60000) {
      lastTabAttendanceScan = now;
      console.log("[Spectra] SPeCTRUM active tab navigation detected. Scheduling attendance check.");
      const stored = await chrome.storage.local.get(["moodle_session"]);
      if (stored.moodle_session?.value) {
        await setupDeclarativeCookieRule(stored.moodle_session.value);
      }
      await checkAutoAttendance();
    }
  }
});

// Setup periodic alarms
async function setupAlarms(intervalMinutes = 15) {
  await chrome.alarms.clearAll();

  // Announcement polling alarm
  chrome.alarms.create("spectra_poll_announcements", {
    periodInMinutes: Math.max(1, intervalMinutes),
    delayInMinutes: 1
  });

  // Urgent deadline checker alarm (every 15-30 mins)
  chrome.alarms.create("spectra_check_deadlines", {
    periodInMinutes: Math.max(15, Math.min(30, intervalMinutes * 2)),
    delayInMinutes: 2
  });

  // Periodic Background Alarm: checkAttendanceAlarm firing every 2 minutes
  chrome.alarms.create("checkAttendanceAlarm", {
    periodInMinutes: 2,
    delayInMinutes: 0.1
  });

  // Backward compatibility alias
  chrome.alarms.create("spectra_check_attendance", {
    periodInMinutes: 2,
    delayInMinutes: 0.2
  });

  console.log(`[Spectra] Alarms registered: checkAttendanceAlarm=2m, Announcements=${intervalMinutes}m.`);
}

// Active wake-up triggers for instant attendance check (< 10 min guarantee)
chrome.tabs.onActivated?.addListener(async () => {
  const now = Date.now();
  if (now - lastAttendanceScanTime > 45000) {
    await checkAutoAttendance();
  }
});

chrome.windows.onFocusChanged?.addListener(async (windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    const now = Date.now();
    if (now - lastAttendanceScanTime > 45000) {
      await checkAutoAttendance();
    }
  }
});

if (chrome.idle?.onStateChanged) {
  chrome.idle.onStateChanged.addListener(async (newState) => {
    if (newState === "active") {
      const now = Date.now();
      if (now - lastAttendanceScanTime > 30000) {
        console.log("[Spectra] Laptop became active. Running immediate attendance check.");
        await checkAutoAttendance();
      }
    }
  });
}

// -------------------------------------------------------------
// Alarm Listener
// -------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "checkAttendanceAlarm" || alarm.name === "spectra_check_attendance") {
    await checkAutoAttendance();
  } else if (alarm.name === "spectra_poll_announcements") {
    await pollAnnouncements();
  } else if (alarm.name === "spectra_check_deadlines") {
    await checkUpcomingDeadlines();
  }
});

// -------------------------------------------------------------
// Cookie Listener (MoodleSession on spectrum.um.edu.my)
// -------------------------------------------------------------
let lastKnownCookieValue = null;

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  const { cookie, removed } = changeInfo;
  if (!cookie.domain.includes("spectrum.um.edu.my") || cookie.name !== COOKIE_NAME) {
    return;
  }

  if (removed) {
    console.log("[Spectra] MoodleSession cookie cleared.");
    lastKnownCookieValue = null;
    await chrome.storage.local.set({
      moodle_session: null,
      moodle_session_valid: false,
      moodle_session_updated: Date.now()
    });
    return;
  }

  // Prevent feedback loop: ignore cookie touch/expiry updates if token value has not changed
  if (cookie.value === lastKnownCookieValue) {
    return;
  }
  const isInitialOrChanged = lastKnownCookieValue !== null && lastKnownCookieValue !== cookie.value;
  lastKnownCookieValue = cookie.value;

  const sessionData = {
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expires: cookie.expirationDate || null,
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({
    moodle_session: sessionData,
    moodle_session_valid: true,
    moodle_session_updated: Date.now()
  });

  // Attach DeclarativeNetRequest header rule with new cookie
  if (sessionData.value) {
    await setupDeclarativeCookieRule(sessionData.value);
  }

  // Trigger Cloud Relay Sync if enabled
  const config = await chrome.storage.local.get(["cloud_relay_enabled", "cloud_relay_url", "cloud_relay_secret"]);
  if (config.cloud_relay_enabled && config.cloud_relay_url) {
    await syncSessionToCloudRelay(sessionData, config.cloud_relay_url, config.cloud_relay_secret);
  }

  // Only trigger immediate attendance check if the session cookie was newly established or changed
  if (isInitialOrChanged) {
    await checkAutoAttendance();
  }
});

// -------------------------------------------------------------
// Session Verification
// -------------------------------------------------------------
async function checkActiveSession() {
  try {
    const session = await getSessionContext();
    const cookie = await chrome.cookies.get({
      url: SPECTRUM_BASE_URL,
      name: COOKIE_NAME
    });

    const sessionData = {
      value: cookie ? cookie.value : "",
      sesskey: session.sesskey,
      userName: session.userName,
      userAvatarUrl: session.userAvatarUrl,
      updatedAt: Date.now()
    };

    await chrome.storage.local.set({
      moodle_session: sessionData,
      moodle_session_valid: true,
      moodle_session_updated: Date.now()
    });

    return { authenticated: true, session: sessionData };
  } catch (err) {
    await chrome.storage.local.set({
      moodle_session: null,
      moodle_session_valid: false,
      moodle_session_updated: Date.now()
    });
    return { authenticated: false, session: null };
  }
}

// -------------------------------------------------------------
// Cloud Relay Sync
// -------------------------------------------------------------
async function syncSessionToCloudRelay(sessionData, relayUrl, secretKey) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (secretKey) {
      headers["Authorization"] = `Bearer ${secretKey}`;
    }

    const store = await chrome.storage.local.get([
      "cached_courses",
      "courses",
      "spectrum_live_session",
      "trackedAttendanceUrls",
      "cached_attendance",
      "course_occurrences",
      "course_passwords",
      "moodle_session_key",
      "telegram_bot_token",
      "telegram_chat_id",
      "calendarIcalUrl",
      "calendar_ical_url"
    ]);

    // Ensure courses falls back across store.cached_courses, store.courses, and store.spectrum_live_session?.courses
    const rawCourses = (Array.isArray(store.cached_courses) && store.cached_courses.length > 0)
      ? store.cached_courses
      : ((Array.isArray(store.courses) && store.courses.length > 0)
        ? store.courses
        : (store.spectrum_live_session?.courses || []));

    const courses = (rawCourses || []).map((c) => ({
      id: String(c.id || c.courseId || ""),
      code: c.code || c.shortname || String(c.id || ""),
      name: c.name || c.fullname || ""
    })).filter(c => c.id && c.id !== "1");

    // Extract explicit attendance view URLs directly
    const attendanceUrlsSet = new Set();
    if (Array.isArray(store.trackedAttendanceUrls)) {
      for (const u of store.trackedAttendanceUrls) {
        if (typeof u === "string" && u.includes("/mod/attendance/view.php")) {
          attendanceUrlsSet.add(u.trim());
        }
      }
    }
    if (Array.isArray(store.cached_attendance?.courses)) {
      for (const cr of store.cached_attendance.courses) {
        if (cr.viewUrl && typeof cr.viewUrl === "string") attendanceUrlsSet.add(cr.viewUrl.trim());
        if (cr.attendanceUrl && typeof cr.attendanceUrl === "string") attendanceUrlsSet.add(cr.attendanceUrl.trim());
        if (Array.isArray(cr.instances)) {
          for (const inst of cr.instances) {
            if (inst.viewUrl) attendanceUrlsSet.add(inst.viewUrl.trim());
            if (inst.url) attendanceUrlsSet.add(inst.url.trim());
          }
        }
      }
    }
    const attendanceUrls = Array.from(attendanceUrlsSet);

    const cleanBase = (relayUrl || "").replace(/\/+(?:sync-cookie|sync)?\/?$/, "");
    const targetUrl = cleanBase ? `${cleanBase}/sync-cookie` : relayUrl;

    const payload = {
      action: "SESSION_SYNC",
      timestamp: Date.now(),
      domain: "spectrum.um.edu.my",
      cookieName: COOKIE_NAME,
      cookie: sessionData.value,
      sessionToken: sessionData.value,
      moodleSession: sessionData.value,
      expires: sessionData.expires,
      sesskey: store.moodle_session_key || sessionData.sesskey || store.spectrum_live_session?.sesskey || "",
      calendarIcalUrl: store.calendarIcalUrl || store.calendar_ical_url || "",
      courses,
      attendanceUrls,
      occurrences: store.course_occurrences || {},
      passwords: store.course_passwords || {},
      telegramToken: store.telegram_bot_token || "",
      telegramChatId: store.telegram_chat_id || "",
      client: "Spectra Chrome Extension v1.0.2"
    };

    const res = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      await chrome.storage.local.set({ last_cloud_sync_timestamp: Date.now() });
      return { success: true };
    } else {
      const text = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${text}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// -------------------------------------------------------------
// Notification Dispatcher (Telegram)
// -------------------------------------------------------------
export { sendTelegramMessage };

// -------------------------------------------------------------
// Live Announcement Polling Workflow
// -------------------------------------------------------------
async function pollAnnouncements() {
  const store = await chrome.storage.local.get([
    "telegram_bot_token",
    "telegram_chat_id",
    "notify_announcements",
    "telegram_sent_announcement_ids"
  ]);

  if (!store.notify_announcements) return;

  const hasTelegram = Boolean(store.telegram_bot_token && store.telegram_chat_id);
  if (!hasTelegram) return;

  // 1. Verify live session
  let sessionContext;
  try {
    sessionContext = await getSessionContext();
  } catch (err) {
    console.log("[Spectra] Background polling skipped: SPeCTRUM session not authenticated.");
    return;
  }

  const telegramSentIds = new Set(store.telegram_sent_announcement_ids || []);
  let announcements = [];

  // 2. Query enrolled courses & forum announcements
  try {
    const courses = await getLiveEnrolledCourses(sessionContext.sesskey);
    announcements = await fetchLiveAnnouncements(courses, sessionContext.sesskey);
  } catch (err) {
    console.warn("[Spectra] Polling live announcements failed:", err);
    return;
  }

  // Dispatch only announcements that have not been confirmed sent to Telegram.
  for (const item of announcements) {
    const itemIdStr = String(item.id);

    // STRICT REQUIREMENT: Only send announcements that have NOT been flagged as sent to Telegram
    if (hasTelegram && !telegramSentIds.has(itemIdStr)) {
      try {
        const telegramHtml = formatAnnouncementTelegram(item);
        const res = await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, telegramHtml);
        if (res && (res.success || res.ok || res.messageId || res.message_id)) {
          telegramSentIds.add(itemIdStr);
          await chrome.storage.local.set({
            telegram_sent_announcement_ids: Array.from(telegramSentIds)
          });
          console.log(`[Spectra Telegram] Sent announcement "${item.subject}" (${itemIdStr}) and flagged as sent.`);
        }
      } catch (tgErr) {
        console.error("[Spectra] Telegram dispatch failed:", tgErr);
      }
    }

  }

  // Cache current announcements for popup UI with telegramSent flag annotated
  const annotatedAnnouncements = announcements.map((a) => ({
    ...a,
    telegramSent: telegramSentIds.has(String(a.id))
  }));

  await chrome.storage.local.set({
    cached_announcements: annotatedAnnouncements,
    telegram_sent_announcement_ids: Array.from(telegramSentIds),
    last_sync_timestamp: Date.now()
  });
}

// -------------------------------------------------------------
// Live Urgent Deadline Checking (< 24 Hours)
// -------------------------------------------------------------
async function checkUpcomingDeadlines() {
  const store = await chrome.storage.local.get([
    "notify_urgent_deadlines",
    "telegram_bot_token",
    "telegram_chat_id",
    "completed_assignment_ids",
    "telegram_sent_deadline_ids",
    "cached_courses",
    "courses",
    "course_occurrences",
    "courseOccurrences",
    "studentOccurrence"
  ]);

  if (!store.notify_urgent_deadlines) return;

  const hasTelegram = Boolean(store.telegram_bot_token && store.telegram_chat_id);
  if (!hasTelegram) return;

  let sessionContext;
  try {
    sessionContext = await getSessionContext();
  } catch (err) {
    return;
  }

  const completed = new Set(store.completed_assignment_ids || []);
  const telegramSentDeadlineIds = new Set(store.telegram_sent_deadline_ids || []);
  const occMap = store.course_occurrences || store.courseOccurrences || {};
  const courseList = store.courses || store.cached_courses || [];

  let deadlines = [];
  try {
    deadlines = await fetchLiveDeadlines(
      sessionContext.sesskey,
      courseList,
      occMap,
      store.studentOccurrence
    );
    if (Array.isArray(deadlines)) {
      const validDeadlines = deadlines.filter((d) => {
        if (!d || typeof d !== "object") return false;
        if (isAttendanceActivity(d)) return false;
        if (isOverdueMoreThan40Days(d.dueTimestamp)) return false;
        const title = (d.title || d.name || "").trim();
        if (!title) return false;
        const isSynthetic = (
          (d.id && String(d.id).startsWith("scraped-") && (!d.url || d.url.includes("/my/"))) ||
          (d.courseCode === "UM" && (!d.url || !d.url.includes("view.php?id=")))
        );
        return !isSynthetic;
      });
      await chrome.storage.local.set({ cached_deadlines: validDeadlines });
    }
  } catch (err) {
    console.warn("[Spectra] Error querying live deadlines in background:", err);
    return;
  }

  const now = Date.now();
  const urgentItems = deadlines.filter((d) => {
    // Strictly exclude attendance from submission due
    if (isAttendanceActivity(d)) return false;
    if (completed.has(String(d.id)) || d.isCompleted || d.isSubmittedOnSpectrum) return false;
    if (!d.dueTimestamp) return false;
    const diffHours = (d.dueTimestamp - now) / (1000 * 60 * 60);
    // Alert for impending submissions due 1 day before (0 < diffHours <= 24)
    return diffHours > 0 && diffHours <= 24;
  });

  for (const item of urgentItems) {
    const itemIdStr = String(item.id);
    const hoursLeft = Math.max(1, Math.round((item.dueTimestamp - Date.now()) / (1000 * 60 * 60)));

    // STRICT REQUIREMENT: Only send due date submission that has NOT been flagged as sent to Telegram
    if (hasTelegram && !telegramSentDeadlineIds.has(itemIdStr)) {
      try {
        const telegramHtml = formatDeadlineTelegram(item);
        const res = await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, telegramHtml);
        if (res && (res.success || res.ok || res.messageId || res.message_id)) {
          telegramSentDeadlineIds.add(itemIdStr);
          await chrome.storage.local.set({
            telegram_sent_deadline_ids: Array.from(telegramSentDeadlineIds)
          });
          console.log(`[Spectra Telegram] Sent deadline alert "${item.title}" (${itemIdStr}) and flagged as sent.`);
        }
      } catch (e) {
        console.error("[Spectra] Telegram deadline alert failed:", e);
      }
    }

  }

  await chrome.storage.local.set({
    telegram_sent_deadline_ids: Array.from(telegramSentDeadlineIds)
  });
}

// -------------------------------------------------------------
// Headless Auto-Attendance Scanner (2-Min Periodic & Event-Driven)
// -------------------------------------------------------------
let isAttendanceScanning = false;
let lastAttendanceScanTime = 0;

async function checkAutoAttendance() {
  const now = Date.now();
  // Concurrency & rate-limiting guard: reset stuck lock (>120s), skip if running or throttled <25s
  if (isAttendanceScanning) {
    if (now - lastAttendanceScanTime > 120000) {
      console.warn("[Spectra] Resetting stuck isAttendanceScanning lock (>120s).");
      isAttendanceScanning = false;
    } else {
      console.log("[Spectra] Attendance scan skipped (already running).");
      return;
    }
  }
  if (now - lastAttendanceScanTime < 25000) {
    console.log("[Spectra] Attendance scan throttled (<25s).");
    return;
  }
  isAttendanceScanning = true;
  lastAttendanceScanTime = now;

  try {
    // 1. Check if MoodleSession exists via chrome.cookies.get
    const cookie = await chrome.cookies.get({ url: "https://spectrum.um.edu.my", name: COOKIE_NAME });
    if (!cookie || !cookie.value) {
      console.log("[Spectra Headless] Attendance scan skipped: No active MoodleSession cookie found.");
      return;
    }
    const cookieVal = cookie.value;
    await setupDeclarativeCookieRule(cookieVal);

    const store = await chrome.storage.local.get([
      "pref_auto_attendance",
      "trackedAttendanceUrls",
      "submittedSessions",
      "recorded_attendance_sessids",
      "course_passwords",
      "course_occurrences",
      "telegram_bot_token",
      "telegram_chat_id",
      "cached_courses",
      "courses",
      "spectrum_live_session",
      "moodle_session"
    ]);

    // Respect user toggle (default enabled)
    if (store.pref_auto_attendance === false) {
      return;
    }

    const submittedSet = new Set([
      ...(store.submittedSessions || []),
      ...(store.recorded_attendance_sessids || [])
    ]);

    // 2. Fetch list of user's active attendance links (from trackedAttendanceUrls or resolve dynamically)
    let trackedUrls = Array.isArray(store.trackedAttendanceUrls) ? [...store.trackedAttendanceUrls] : [];
    let courses = (Array.isArray(store.cached_courses) && store.cached_courses.length > 0)
      ? store.cached_courses
      : ((Array.isArray(store.courses) && store.courses.length > 0)
        ? store.courses
        : (store.spectrum_live_session?.courses || []));
    let sesskey = store.moodle_session?.sesskey || store.spectrum_live_session?.sesskey || store.verifiedSesskey || "";

    if (trackedUrls.length === 0 || !courses || courses.length === 0) {
      try {
        const sessionContext = await getSessionContext();
        sesskey = sessionContext.sesskey || sesskey;
        courses = await getLiveEnrolledCourses(sesskey);
      } catch (err) {
        console.warn("[Spectra Headless] Note loading live courses:", err?.message || err);
      }

      if (courses && courses.length > 0) {
        const discoveredUrls = new Set(trackedUrls);
        for (const course of courses) {
          const cid = course.id || course.courseId;
          if (!cid) continue;

          let foundForCourse = false;
          // Try /mod/attendance/index.php?id=${cid}
          try {
            const indexRes = await fetch(`https://spectrum.um.edu.my/mod/attendance/index.php?id=${encodeURIComponent(cid)}`, {
              credentials: "include"
            });
            if (indexRes.ok) {
              const indexHtml = await indexRes.text();
              const matches = indexHtml.match(/href=["']([^"']*\/mod\/attendance\/view\.php\?[^"']*)["']/gi) || [];
              for (const m of matches) {
                const uMatch = m.match(/href=["']([^"']+)["']/i);
                if (uMatch) {
                  const fullUrl = uMatch[1].startsWith("http") ? uMatch[1] : `https://spectrum.um.edu.my/${uMatch[1].replace(/^\//, "")}`;
                  discoveredUrls.add(fullUrl);
                  foundForCourse = true;
                }
              }
            }
          } catch (_) { }

          // Fallback: If mod/attendance/index.php had no attendance links, inspect /course/view.php?id=${cid} directly
          if (!foundForCourse) {
            try {
              const courseRes = await fetch(`https://spectrum.um.edu.my/course/view.php?id=${encodeURIComponent(cid)}`, {
                credentials: "include"
              });
              if (courseRes.ok) {
                const courseHtml = await courseRes.text();
                const matches = courseHtml.match(/href=["']([^"']*\/mod\/attendance\/view\.php\?[^"']*)["']/gi) || [];
                for (const m of matches) {
                  const uMatch = m.match(/href=["']([^"']+)["']/i);
                  if (uMatch) {
                    const fullUrl = uMatch[1].startsWith("http") ? uMatch[1] : `https://spectrum.um.edu.my/${uMatch[1].replace(/^\//, "")}`;
                    discoveredUrls.add(fullUrl);
                  }
                }
              }
            } catch (_) { }
          }
        }
        if (discoveredUrls.size > 0) {
          trackedUrls = Array.from(discoveredUrls);
          await chrome.storage.local.set({ trackedAttendanceUrls: trackedUrls });
        }
      }
    }

    // 3. For each course attendance page (/mod/attendance/view.php?id=...)
    let newlySubmitted = false;
    for (const viewUrl of trackedUrls) {
      try {
        const targetViewUrl = viewUrl.includes("view=") ? viewUrl : `${viewUrl}&view=5`;
        const res = await fetch(targetViewUrl, {
          method: "GET",
          credentials: "include"
        });
        if (!res.ok) continue;
        const viewHtml = await res.text();

        // Detect if a "Submit attendance" link is active
        const submitMatch = viewHtml.match(/href=["']([^"']*attendance\.php\?(sessid=(\d+)[^"'>\s]*))["'][^>]*>([\s\S]*?)<\/a>/i) ||
          viewHtml.match(/attendance\.php\?(sessid=(\d+)&amp;sesskey=[^"'>\s]+)/i) ||
          viewHtml.match(/attendance\.php\?(sessid=(\d+)[^"'>\s]*)/i);

        if (!submitMatch) continue;

        let query = "";
        let sessid = "";
        if (submitMatch[1]?.includes("sessid=")) {
          query = submitMatch[1].replace(/&amp;/g, "&");
          const sm = query.match(/sessid=(\d+)/);
          sessid = sm ? sm[1] : (submitMatch[2] || "");
        } else {
          query = submitMatch[0].replace(/&amp;/g, "&").replace(/^attendance\.php\?/, "");
          sessid = submitMatch[2] || "";
        }

        if (!sessid || submittedSet.has(sessid)) {
          continue;
        }

        // 3.1. GET the submission page
        const submitPageUrl = query.startsWith("http")
          ? query
          : `https://spectrum.um.edu.my/mod/attendance/attendance.php?${query.replace(/^[^?]*\?/, "")}`;

        const formRes = await fetch(submitPageUrl, {
          method: "GET",
          credentials: "include"
        });
        if (!formRes.ok) continue;
        const formHtml = await formRes.text();

        // 3.2. Extract sessid, sesskey (CSRF token), and statusId for Present
        const sesskeyMatch = formHtml.match(/name=["']sesskey["'][^>]*value=["']([^"']+)["']/i) ||
          formHtml.match(/value=["']([^"']+)["'][^>]*name=["']sesskey["']/i) ||
          formHtml.match(/"sesskey":"([^"]+)"/);
        const formSesskey = sesskeyMatch ? sesskeyMatch[1] : (sesskey || "");

        const sessidMatch = formHtml.match(/name=["']sessid["'][^>]*value=["'](\d+)["']/i) ||
          formHtml.match(/value=["'](\d+)["'][^>]*name=["']sessid["']/i);
        const finalSessid = sessidMatch ? sessidMatch[1] : sessid;

        let statusId = null;
        const inputStatusRegex = /<input[^>]*name=["']status["'][^>]*>/gi;
        let inMatch;
        while ((inMatch = inputStatusRegex.exec(formHtml)) !== null) {
          const tagStr = inMatch[0];
          const valM = tagStr.match(/value=["'](\d+)["']/i);
          const idM = tagStr.match(/id=["']([^"']+)["']/i);
          if (!valM) continue;
          const val = valM[1];

          let isPresent = false;
          if (idM) {
            const labelForRegex = new RegExp(`<label[^>]*for=["']${idM[1]}["'][^>]*>([\\s\\S]*?)<\\/label>`, "i");
            const lMatch = formHtml.match(labelForRegex);
            if (lMatch && /present|hadir|^p\b/i.test(lMatch[1].replace(/<[^>]+>/g, "").trim())) {
              isPresent = true;
            }
          }
          if (!isPresent) {
            const afterInput = formHtml.substring(inputStatusRegex.lastIndex, inputStatusRegex.lastIndex + 300);
            const nextLabelM = afterInput.match(/^[\s\S]*?<label[^>]*>([\s\S]*?)<\/label>/i);
            if (nextLabelM && /present|hadir|^p\b/i.test(nextLabelM[1].replace(/<[^>]+>/g, "").trim())) {
              isPresent = true;
            }
          }
          if (!isPresent) {
            const surrounding = formHtml.substring(Math.max(0, inMatch.index - 50), Math.min(formHtml.length, inMatch.index + 200));
            if (/present|hadir/i.test(surrounding)) {
              isPresent = true;
            }
          }
          if (isPresent) {
            statusId = val;
            break;
          }
        }

        // Fallback: Pick first radio option
        if (!statusId) {
          const anyRadio = formHtml.match(/name=["']status["'][^>]*value=["'](\d+)["']/i) ||
            formHtml.match(/value=["'](\d+)["'][^>]*name=["']status["']/i) ||
            formHtml.match(/<input[^>]+type=["']radio["'][^>]+value=["'](\d+)["']/i);
          if (anyRadio) statusId = anyRadio[1];
        }

        if (!statusId) continue;

        // Check password field if required
        const hasPassword = /<input[^>]+name=["'](studentpassword|password)["']/i.test(formHtml);
        let password = "";
        if (hasPassword && store.course_passwords) {
          for (const pwd of Object.values(store.course_passwords)) {
            if (pwd && String(pwd).trim()) {
              password = String(pwd).trim();
              break;
            }
          }
        }

        // 3.4. Submit attendance via headless POST
        const postBody = new URLSearchParams();
        postBody.append("sessid", finalSessid);
        postBody.append("sesskey", formSesskey);
        postBody.append("status", statusId);
        postBody.append("mform_is_submitted", "1");
        postBody.append("submitbutton", "Save changes");
        if (password) {
          postBody.append("studentpassword", password);
          postBody.append("password", password);
        }

        const postRes = await fetch("https://spectrum.um.edu.my/mod/attendance/attendance.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          credentials: "include",
          body: postBody.toString()
        });

        const postText = await postRes.text();
        const isConfirmed = postRes.ok && (
          postRes.redirected ||
          postRes.url.includes("view.php") ||
          /(?:your attendance has been (?:successfully )?recorded|attendance (?:has been|was) successfully recorded|kehadiran anda telah direkodkan)/i.test(postText)
        );

        if (isConfirmed) {
          // 3.5. On success: Append sessid to submittedSessions
          submittedSet.add(finalSessid);
          newlySubmitted = true;
          console.log(`[Spectra Headless] Auto-submitted Present for sessid=${finalSessid}!`);

          // Dispatch native desktop notification
          if (typeof chrome !== "undefined" && chrome.notifications?.create) {
            chrome.notifications.create(`attendance_${finalSessid}`, {
              type: "basic",
              iconUrl: chrome.runtime.getURL("icons/icon128.png"),
              title: "Spectra Auto-Attendance",
              message: "Attendance marked Present on SPeCTRUM! ✅",
              priority: 2
            });
          }

          // Dispatch Telegram notification if configured
          if (store.telegram_bot_token && store.telegram_chat_id) {
            try {
              let detectedCode = "SPeCTRUM Class";
              const titleM = viewHtml.match(/<title>([^<]+)<\/title>/i);
              if (titleM) {
                const codeM = titleM[1].match(/\b([A-Z]{3,4}\s*\d{4}[A-Z]?)\b/i);
                if (codeM) detectedCode = codeM[1].replace(/\s+/g, "").toUpperCase();
              }
              const nowFormatted = new Date().toLocaleString("en-MY", {
                timeZone: "Asia/Kuala_Lumpur",
                dateStyle: "medium",
                timeStyle: "short"
              });
              const html = formatAttendanceTelegram({
                courseCode: detectedCode,
                occurrence: "Auto",
                status: "Present",
                sessionDescription: "Headless Background Check-In",
                time: nowFormatted,
                success: true
              });
              await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, html);
            } catch (tgErr) {
              console.error("[Spectra Headless] Telegram alert failed:", tgErr);
            }
          }
        }
      } catch (itemErr) {
        console.warn("[Spectra Headless] Error checking viewUrl:", itemErr);
      }
    }

    if (newlySubmitted) {
      await chrome.storage.local.set({
        submittedSessions: Array.from(submittedSet),
        recorded_attendance_sessids: Array.from(submittedSet)
      });
    }

    // Refresh UI attendance cache for extension popup
    if (courses && courses.length > 0) {
      try {
        const occurrencesMap = store.course_occurrences || {};
        const passwordsMap = store.course_passwords || {};
        const { attendance } = await scanAndAutoRecordAttendance({
          courses,
          sesskey,
          occurrencesMap,
          autoSubmit: false,
          passwordsMap
        });
        await chrome.storage.local.set({
          cached_attendance: attendance,
          last_attendance_sync: Date.now()
        });
      } catch (_) { }
    }
  } catch (err) {
    console.warn("[Spectra] Error during headless auto-attendance run:", err);
  } finally {
    isAttendanceScanning = false;
  }
}

// -------------------------------------------------------------
// Batch Download Handler
// -------------------------------------------------------------
async function handleBatchDownload(files, courseCode, weekNumber) {
  if (!Array.isArray(files) || files.length === 0) {
    return { success: false, message: "No files provided for download." };
  }

  const cleanCourse = (courseCode || "UM").replace(/[^a-zA-Z0-9_-]/g, "");
  const folderPath = `Spectra/${cleanCourse}/Week_${weekNumber}`;
  const downloadResults = [];

  for (const file of files) {
    try {
      const sanitizedFilename = (file.name || "download")
        .replace(/[/\\?%*:|"<>]/g, "_")
        .trim();

      const targetPath = `${folderPath}/${sanitizedFilename}`;

      const downloadId = await chrome.downloads.download({
        url: file.url,
        filename: targetPath,
        saveAs: false,
        conflictAction: "uniquify"
      });

      downloadResults.push({ id: downloadId, name: sanitizedFilename, success: true });
    } catch (err) {
      console.warn(`[Spectra] Failed downloading ${file.name}:`, err);
      downloadResults.push({ name: file.name, success: false, error: err.message });
    }
  }

  return {
    success: true,
    total: files.length,
    downloaded: downloadResults.filter((r) => r.success).length,
    results: downloadResults,
    folder: folderPath
  };
}

// Helper: Escape Telegram Markdown characters
function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/([_*[\]()~`>#+=|{}.!-])/g, "\\$1");
}

// -------------------------------------------------------------
// Message Router
// -------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action, payload } = request;

  (async () => {
    try {
      switch (action) {
        case "CHECK_SESSION": {
          const session = await checkActiveSession();
          sendResponse({ success: true, data: session });
          break;
        }

        case "SEND_TEST_TELEGRAM": {
          const { botToken, chatId } = payload || {};
          const result = await sendTelegramTestMessage(botToken, chatId);
          sendResponse({ success: true, message: "Telegram test notification delivered successfully!", data: result });
          break;
        }

        case "SYNC_CLOUD_RELAY_NOW": {
          const session = await checkActiveSession();
          if (!session.authenticated) {
            sendResponse({ success: false, message: "No active MoodleSession found. Please log in to SPeCTRUM first." });
            return;
          }
          const { relayUrl, secretKey } = payload || {};
          const result = await syncSessionToCloudRelay(session.session, relayUrl, secretKey);
          sendResponse(result);
          break;
        }

        case "INJECT_AND_SCRAPE_SPECTRUM": {
          const { moodleSession } = payload || {};
          const res = await injectAndScrapeSpectrum(moodleSession);
          sendResponse({ success: true, data: res });
          break;
        }

        case "DOWNLOAD_WEEK_PACK": {
          const { files, courseCode, weekNumber } = payload || {};
          const result = await handleBatchDownload(files, courseCode, weekNumber);
          sendResponse(result);
          break;
        }

        case "MANUAL_SYNC_ANNOUNCEMENTS": {
          await pollAnnouncements();
          const stored = await chrome.storage.local.get(["cached_announcements"]);
          sendResponse({ success: true, announcements: stored.cached_announcements || [] });
          break;
        }

        case "CHECK_DEADLINES":
        case "MANUAL_SYNC_DEADLINES": {
          await checkUpcomingDeadlines();
          const stored = await chrome.storage.local.get(["telegram_sent_deadline_ids"]);
          sendResponse({ success: true, sentDeadlineIds: stored.telegram_sent_deadline_ids || [] });
          break;
        }

        case "GET_LIVE_ANNOUNCEMENTS": {
          const stored = await chrome.storage.local.get(["cached_announcements"]);
          if (stored.cached_announcements && stored.cached_announcements.length > 0) {
            sendResponse({ success: true, announcements: stored.cached_announcements });
          } else {
            await pollAnnouncements();
            const recheck = await chrome.storage.local.get(["cached_announcements"]);
            sendResponse({ success: true, announcements: recheck.cached_announcements || [] });
          }
          break;
        }

        case "GET_LIVE_ATTENDANCE": {
          const store = await chrome.storage.local.get(["course_occurrences", "cached_attendance"]);
          const occurrencesMap = store.course_occurrences || {};
          const session = await getSessionContext();
          const courses = await getLiveEnrolledCourses(session.sesskey);
          const attendanceData = await fetchLiveAllAttendance(courses, session.sesskey, occurrencesMap);
          await chrome.storage.local.set({ cached_attendance: attendanceData, last_attendance_sync: Date.now() });
          sendResponse({ success: true, data: attendanceData });
          break;
        }

        case "SAVE_COURSE_OCCURRENCE": {
          const { courseId, occurrence } = payload || {};
          const store = await chrome.storage.local.get(["course_occurrences"]);
          const occurrencesMap = store.course_occurrences || {};
          if (courseId) {
            occurrencesMap[courseId] = (occurrence || "").trim();
            await chrome.storage.local.set({ course_occurrences: occurrencesMap });
          }
          sendResponse({ success: true, occurrences: occurrencesMap });
          break;
        }

        case "SCAN_AUTO_ATTENDANCE_NOW": {
          const store = await chrome.storage.local.get(["course_occurrences", "course_passwords"]);
          const occurrencesMap = store.course_occurrences || {};
          const passwordsMap = store.course_passwords || {};
          const session = await getSessionContext();
          const courses = await getLiveEnrolledCourses(session.sesskey);
          const scanRes = await scanAndAutoRecordAttendance({
            courses,
            sesskey: session.sesskey,
            occurrencesMap,
            autoSubmit: true,
            passwordsMap
          });
          sendResponse({ success: true, data: scanRes });
          break;
        }

        case "SUBMIT_MANUAL_ATTENDANCE": {
          const { sessid, attendanceUrl, password } = payload || {};
          const session = await getSessionContext();
          const result = await autoSubmitAttendance({
            sessid,
            sesskey: session.sesskey,
            attendanceUrl,
            password
          });
          sendResponse(result);
          break;
        }

        case "RECORD_ATTENDANCE_SUCCESS": {
          const { sessid, courseCode, status = "Present", sessionDescription, url } = payload || {};
          const store = await chrome.storage.local.get([
            "recorded_attendance_sessids",
            "submittedSessions",
            "telegram_bot_token",
            "telegram_chat_id"
          ]);

          const recorded = new Set(store.recorded_attendance_sessids || []);
          const submitted = new Set(store.submittedSessions || []);
          if (sessid && !recorded.has(sessid)) {
            recorded.add(sessid);
            submitted.add(sessid);
            await chrome.storage.local.set({
              recorded_attendance_sessids: Array.from(recorded),
              submittedSessions: Array.from(submitted)
            });

            if (store.telegram_bot_token && store.telegram_chat_id) {
              try {
                const nowFormatted = new Date().toLocaleString("en-MY", {
                  timeZone: "Asia/Kuala_Lumpur",
                  dateStyle: "medium",
                  timeStyle: "short"
                });
                const html = formatAttendanceTelegram({
                  courseCode: courseCode || "SPeCTRUM Class",
                  occurrence: "General",
                  status,
                  sessionDescription: sessionDescription || "In-Browser Attendance Check-In",
                  time: nowFormatted,
                  success: true
                });
                await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, html);
              } catch (e) {
                console.error("[Spectra] Failed dispatching Telegram alert for in-page attendance:", e);
              }
            }

          }
          sendResponse({ success: true });
          break;
        }

        case "UPDATE_ALARMS": {
          const { intervalMinutes } = payload || {};
          await setupAlarms(intervalMinutes || 15);
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, message: `Unknown action: ${action}` });
      }
    } catch (err) {
      console.error(`[Spectra] Action ${action} threw error:`, err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

// Ensure alarms and auto-attendance scanner are always registered on service worker evaluation
chrome.storage.local.get(["poll_interval_mins"]).then((st) => {
  setupAlarms(st.poll_interval_mins || 15).catch(() => {});
}).catch(() => {});
