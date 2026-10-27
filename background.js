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
    notify_attendance_open: true,
    sent_tg_open_attendance_sessids: [],
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
  // Concurrency & rate-limiting guard: skip if already running or ran < 25 seconds ago
  if (isAttendanceScanning || (now - lastAttendanceScanTime < 25000)) {
    return;
  }
  isAttendanceScanning = true;
  lastAttendanceScanTime = now;

  try {
    // 1. Check if MoodleSession exists via chrome.cookies.get
    const cookie = await chrome.cookies.get({ url: SPECTRUM_BASE_URL, name: COOKIE_NAME });
    if (!cookie || !cookie.value) {
      return;
    }
    await setupDeclarativeCookieRule(cookie.value);

    const store = await chrome.storage.local.get([
      "notify_attendance_open",
      "telegram_bot_token",
      "telegram_chat_id",
      "sent_tg_open_attendance_sessids",
      "course_occurrences",
      "cached_courses",
      "courses",
      "moodle_session"
    ]);

    let courses = store.cached_courses || store.courses || [];
    let sesskey = store.moodle_session?.sesskey || "";

    if (!courses || courses.length === 0 || !sesskey) {
      try {
        const sessionContext = await getSessionContext();
        sesskey = sessionContext.sesskey || sesskey;
        courses = await getLiveEnrolledCourses(sesskey);
        if (courses.length > 0) {
          await chrome.storage.local.set({ cached_courses: courses });
        }
      } catch (err) {
        console.warn("[Spectra] Note loading courses for attendance detector:", err?.message || err);
      }
    }

    if (!courses || courses.length === 0) return;

    const occurrencesMap = store.course_occurrences || {};

    // 2. Fetch live attendance data across courses
    const attendanceData = await fetchLiveAllAttendance(courses, sesskey, occurrencesMap);

    // 3. Cache updated attendance
    await chrome.storage.local.set({
      cached_attendance: attendanceData,
      last_attendance_sync: Date.now()
    });

    // 4. Check for open sessions and alert via Telegram & desktop notifications if enabled
    const openSessions = attendanceData.openSessions || [];
    const sentTgSet = new Set(store.sent_tg_open_attendance_sessids || []);
    let sentNewAlert = false;

    for (const item of openSessions) {
      const sessid = item.session?.sessid;
      if (!sessid || sentTgSet.has(String(sessid))) continue;

      sentTgSet.add(String(sessid));
      sentNewAlert = true;

      // Dispatch native desktop notification
      if (typeof chrome !== "undefined" && chrome.notifications?.create) {
        chrome.notifications.create(`open_att_${sessid}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: `Attendance Open: ${item.courseCode}`,
          message: `Check-in is open for ${item.session?.description || "class"}. Click Submit in Spectra!`,
          priority: 2
        });
      }

      // Dispatch Telegram notification if enabled
      const tgAlertEnabled = store.notify_attendance_open !== false;
      if (tgAlertEnabled && store.telegram_bot_token && store.telegram_chat_id) {
        try {
          const directUrl = item.session?.submitUrl || item.viewUrl || "https://spectrum.um.edu.my/my/";
          const msgHtml = [
            `🔔 <b>Spectra Attendance Alert: ${escapeHtml(item.courseCode)}</b>`,
            `<b>Session:</b> ${escapeHtml(item.session?.description || "Class Session")}`,
            `<b>Occurrence:</b> ${escapeHtml(item.occurrence || "General")}`,
            `<b>Status:</b> 🟢 <b>Check-in is now OPEN!</b>`,
            ``,
            `Open the Spectra extension and click <b>Submit</b>, or check in directly on SPeCTRUM:`,
            `👉 <a href="${directUrl}">Submit Attendance on SPeCTRUM</a>`
          ].join("\n");

          await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, msgHtml);
          console.log(`[Spectra] Dispatched Telegram open attendance alert for sessid=${sessid}`);
        } catch (tgErr) {
          console.warn("[Spectra] Telegram open attendance alert failed:", tgErr);
        }
      }
    }

    if (sentNewAlert) {
      await chrome.storage.local.set({
        sent_tg_open_attendance_sessids: Array.from(sentTgSet)
      });
    }
  } catch (err) {
    console.warn("[Spectra] Error during attendance scan:", err);
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
          sendResponse({ success: false, message: "Cloud Relay is disabled. Spectra runs 100% locally in Chrome." });
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
          await checkAutoAttendance();
          const store = await chrome.storage.local.get(["cached_attendance"]);
          sendResponse({ success: true, data: store.cached_attendance || null });
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

        case "ATTENDANCE_SUBMITTED_SUCCESS":
        case "RECORD_ATTENDANCE_SUCCESS": {
          const { sessid, courseCode, status = "Present", sessionDescription } = payload || {};
          const store = await chrome.storage.local.get([
            "recorded_attendance_sessids",
            "cached_attendance",
            "telegram_bot_token",
            "telegram_chat_id"
          ]);

          const recorded = new Set(store.recorded_attendance_sessids || []);
          if (sessid) recorded.add(sessid);

          // Update cached_attendance so popup reflects it immediately without a full network refetch
          let cached = store.cached_attendance;
          if (cached && cached.courses) {
            for (const c of cached.courses) {
              if (c.sessions) {
                for (const s of c.sessions) {
                  if (String(s.sessid) === String(sessid)) {
                    s.status = "present";
                    s.statusClass = "status-present";
                    s.statusLabel = "Present";
                    s.submitted = true;
                    s.isOpen = false;
                    s.submitUrl = null;
                  }
                }
              }
              if (c.openSession && String(c.openSession.sessid) === String(sessid)) {
                c.hasOpenSession = false;
                c.openSession = null;
              }
            }
            if (cached.openSessions) {
              cached.openSessions = cached.openSessions.filter(
                (item) => String(item.session?.sessid) !== String(sessid)
              );
            }
            if (cached.summary) {
              cached.summary.openSessionsCount = cached.openSessions?.length || 0;
            }
          }

          await chrome.storage.local.set({
            recorded_attendance_sessids: Array.from(recorded),
            cached_attendance: cached,
            last_attendance_submitted: Date.now()
          });

          // Broadcast to any open popup
          try {
            chrome.runtime.sendMessage({
              action: "ATTENDANCE_SUBMITTED_SUCCESS",
              payload: { sessid, courseCode, status }
            }).catch(() => {});
          } catch (e) {}

          if (store.telegram_bot_token && store.telegram_chat_id) {
            try {
              const html = formatAttendanceTelegram({
                courseCode: courseCode || "SPeCTRUM Class",
                occurrence: "General",
                status,
                sessionDescription: sessionDescription || "Attendance Recorded (Present)",
                time: "Just now",
                success: true
              });
              await sendTelegramMessage(store.telegram_bot_token, store.telegram_chat_id, html);
            } catch (e) {
              console.error("[Spectra] Failed dispatching Telegram alert for recorded attendance:", e);
            }
          }

          sendResponse({ success: true, cached_attendance: cached });
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
