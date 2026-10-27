/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Live Zero-Mock Popup Controller
 * Connects directly to SPeCTRUM Moodle API, session cookies, and live calendar
 */

import {
  getSessionContext,
  getLiveEnrolledCourses,
  getLiveCourseMaterials,
  fetchLiveAnnouncements,
  fetchCourseAttendance,
  fetchLiveAllAttendance,
  autoSubmitAttendance,
  scanAndAutoRecordAttendance,
  getStoredMoodleCookie,
  saveManualSession,
  autoDetectSession,
  injectAndScrapeSpectrum,
  InvalidSessionError,
  AuthRequiredError,
  AuthExpiredError
} from "./utils/moodleApi.js";

import { fetchLiveDeadlines, normalizeHydratedDeadlines, getTaskFingerprint, deduplicateDeadlinesList, autoDiscoverMoodleIcalUrl } from "./utils/calendar.js";

import {
  formatTimeRemaining,
  formatDueCalendarDate,
  calculateAcademicWeek,
  cleanMoodleTitle,
  extractCourseCode,
  calculateUrgency,
  isRespectiveOccurrence,
  isAttendanceSessionPastOrCurrent,
  isAttendanceActivity,
  isOverdueMoreThan40Days,
  isOverdueMoreThan100Days,
  parseNoticeTimestamp
} from "./utils/parser.js";

import {
  sendTelegramTestMessage,
  sanitizeTelegramToken,
  sanitizeTelegramChatId
} from "./utils/telegram.js";

// Global Application State
const state = {
  currentTab: "deadlines",
  activeFilter: "all",
  searchQuery: "",
  sesskey: null,
  userName: "UM Student",
  userAvatarUrl: "",
  isAuthenticated: false,
  isDemoMode: false,
  deadlines: [],
  completedIds: new Set(),
  courses: [],
  selectedCourse: null,
  selectedWeek: 1,
  currentAcademicWeek: 1,
  weekMaterials: { slides: [], tutorials: [], labs: [] },
  announcements: [],
  selectedAnnouncementSubject: "all",
  attendance: null,
  courseOccurrences: {},
  selectedAttendanceSubject: "all",
  attendanceFilter: "upcoming",
  notifyAttendanceOpen: true,
  telegramSentAnnouncementIds: new Set(),
  telegramSentDeadlineIds: new Set(),
  countdownIntervalId: null,
  loginTabId: null
};

// ===================================================================
// Helper to Open External URLs safely in a Chrome Tab
// ===================================================================
function openExternalUrl(url) {
  if (!url) return;
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank");
  }
}

// ===================================================================
// Initialization
// ===================================================================
document.addEventListener("DOMContentLoaded", async () => {
  try {
    initDOMListeners();
  } catch (err) {
    console.error("[Spectra] Error initializing DOM listeners:", err);
  }

  try {
    await loadStoredPreferences();
  } catch (err) {
    console.error("[Spectra] Error loading stored preferences:", err);
  }

  try {
    await syncLiveSession();
  } catch (err) {
    console.error("[Spectra] Error syncing live session:", err);
  }

  try {
    startLiveCountdowns();
  } catch (err) {
    console.error("[Spectra] Error starting live countdowns:", err);
  }
});

// ===================================================================
// DOM Event Listeners & Tab Switching
// ===================================================================
function initDOMListeners() {
  // Tab Switching
  document.querySelectorAll(".nav-tab-pill, .nav-tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      const targetTab = tabBtn.dataset.tab;
      switchTab(targetTab);
    });
  });

  // Header quick settings button
  const quickSettingsBtn = document.getElementById("quickSettingsBtn");
  if (quickSettingsBtn) {
    quickSettingsBtn.addEventListener("click", () => switchTab("settings"));
  }

  // Footer Demo preview button
  const footerDemoBtn = document.getElementById("footerDemoBtn");
  if (footerDemoBtn) {
    footerDemoBtn.addEventListener("click", enableDemoPreview);
  }

  // Footer Donate button
  const footerDonateBtn = document.getElementById("footerDonateBtn");
  if (footerDonateBtn) {
    footerDonateBtn.addEventListener("click", () => {
      switchTab("settings");
      setTimeout(() => {
        const donationCard = document.getElementById("donationCard");
        if (donationCard) {
          donationCard.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
    });
  }

  // Top Bar Refresh Button
  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.classList.add("spinning");
      await syncLiveSession();
      refreshBtn.classList.remove("spinning");
      showToast("SPeCTRUM data refreshed!", "info");
    });
  }

  // SPeCTRUM Session Authentication Card Handlers
  const saveSessionBtn = document.getElementById("save-session-btn");
  if (saveSessionBtn) {
    saveSessionBtn.addEventListener("click", handleSaveAndTestSession);
  }

  const autoDetectBtn = document.getElementById("auto-detect-btn");
  if (autoDetectBtn) {
    autoDetectBtn.addEventListener("click", handleAutoDetectSession);
  }

  const toggleSessionVisBtn = document.getElementById("toggle-moodle-session-visibility");
  if (toggleSessionVisBtn) {
    toggleSessionVisBtn.addEventListener("click", handleToggleSessionVisibility);
  }

  const sessionInput = document.getElementById("moodle-session-input");
  if (sessionInput) {
    sessionInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSaveAndTestSession();
      }
    });
  }

  // Quick Jump to Settings Links / Buttons
  document.querySelectorAll(".jump-to-settings-btn, #jump-to-settings-btn").forEach((btn) => {
    btn.addEventListener("click", jumpToSettingsTab);
  });

  // Open SPeCTRUM Login Tab with Auto-Watcher
  const openLoginBtn = document.getElementById("openLoginTabBtn");
  if (openLoginBtn) {
    openLoginBtn.addEventListener("click", handleOpenLoginPortal);
  }

  // Auto-Detect Session Button in Disconnected State
  const autoDetectOverlayBtn = document.getElementById("autoDetectOverlayBtn");
  if (autoDetectOverlayBtn) {
    autoDetectOverlayBtn.addEventListener("click", handleAutoDetectSession);
  }

  // Recheck Session Button in Disconnected State
  const recheckBtn = document.getElementById("recheckSessionBtn");
  if (recheckBtn) {
    recheckBtn.addEventListener("click", async () => {
      recheckBtn.disabled = true;
      recheckBtn.textContent = "Verifying live connection...";
      await syncLiveSession();
      recheckBtn.disabled = false;
      recheckBtn.textContent = "Recheck Live Connection";
    });
  }

  // Toggle Manual Cookie Fields in Disconnected View
  const toggleCookieBtn = document.getElementById("toggleManualCookieBtn");
  const cookieFields = document.getElementById("manualCookieFields");
  if (toggleCookieBtn && cookieFields) {
    toggleCookieBtn.addEventListener("click", () => {
      cookieFields.classList.toggle("hidden");
    });
  }

  // Save Manual Cookie Value in Disconnected View
  const saveCookieBtn = document.getElementById("saveManualCookieBtn");
  const cookieInput = document.getElementById("manualCookieInput");
  if (saveCookieBtn && cookieInput) {
    saveCookieBtn.addEventListener("click", async () => {
      const val = cookieInput.value.trim();
      if (!val) {
        showToast("Please enter a valid cookie token", "error");
        return;
      }
      const sessionField = document.getElementById("moodle-session-input");
      if (sessionField) sessionField.value = val;
      await handleSaveAndTestSession();
    });
  }

  // Demo Preview Fallback
  const enableDemoBtn = document.getElementById("enableDemoPreviewBtn");
  if (enableDemoBtn) {
    enableDemoBtn.addEventListener("click", enableDemoPreview);
  }

  // Search & Filter
  const searchInput = document.getElementById("deadlineSearch");
  const clearBtn = document.getElementById("clearSearchBtn");

  if (searchInput && clearBtn) {
    searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value.trim().toLowerCase();
      clearBtn.classList.toggle("hidden", !state.searchQuery);
      renderDeadlines();
    });

    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      state.searchQuery = "";
      clearBtn.classList.add("hidden");
      renderDeadlines();
    });
  }

  // Deadlines filter pills
  document.querySelectorAll("#sectionDeadlines .pill-btn[data-filter]").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll("#sectionDeadlines .pill-btn[data-filter]").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      state.activeFilter = pill.dataset.filter;
      renderDeadlines();
    });
  });

  // Attendance filter pills (Upcoming, History, All)
  document.querySelectorAll(".att-pill-btn").forEach((pill) => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".att-pill-btn").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      state.attendanceFilter = pill.dataset.attFilter || "upcoming";
      renderAttendanceRecords();
    });
  });

  // Course Selector in Class Prep (guarded if removed)
  const courseSelect = document.getElementById("courseSelect");
  if (courseSelect) {
    courseSelect.addEventListener("change", async (e) => {
      const selectedId = e.target.value;
      const found = state.courses.find((c) => c.id === selectedId);
      if (found) {
        state.selectedCourse = found;
      }
    });
  }

  // Subject Dropdown Filter in Announcements Tab
  const announcementSelect = document.getElementById("announcementSubjectSelect");
  if (announcementSelect) {
    announcementSelect.addEventListener("change", (e) => {
      state.selectedAnnouncementSubject = e.target.value;
      renderAnnouncements();
    });
  }

  // Refresh Announcements Button
  const refreshAnnouncementsBtn = document.getElementById("refreshAnnouncementsBtn");
  if (refreshAnnouncementsBtn) {
    refreshAnnouncementsBtn.addEventListener("click", async () => {
      refreshAnnouncementsBtn.disabled = true;
      refreshAnnouncementsBtn.textContent = "Querying forums...";
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.remove(["cached_announcements"]);
      }
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
          await chrome.runtime.sendMessage({ action: "MANUAL_SYNC_ANNOUNCEMENTS" });
        } catch (e) {
          console.warn("[Spectra] Could not trigger background announcement sync:", e);
        }
      }
      await loadLiveAnnouncements();
      refreshAnnouncementsBtn.disabled = false;
      refreshAnnouncementsBtn.textContent = "Check SPeCTRUM Forums";
      showToast("Announcements updated!", "info");
    });
  }

  // Attendance Tab Handlers
  const telegramOpenToggle = document.getElementById("telegramAttendanceOpenToggle");
  if (telegramOpenToggle) {
    telegramOpenToggle.addEventListener("change", async (e) => {
      state.notifyAttendanceOpen = e.target.checked;
      const lbl = document.getElementById("telegramAttendanceOpenLabel");
      if (lbl) lbl.textContent = e.target.checked ? "Telegram Alert Active" : "Telegram Alert Paused";
      const prefOpen = document.getElementById("prefAttendanceOpen");
      if (prefOpen) prefOpen.checked = e.target.checked;
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ notify_attendance_open: e.target.checked });
      }
      showToast(`Telegram open alert ${e.target.checked ? "enabled" : "paused"}.`, "info");
    });
  }

  const prefAttendanceOpen = document.getElementById("prefAttendanceOpen");
  if (prefAttendanceOpen) {
    prefAttendanceOpen.addEventListener("change", async (e) => {
      state.notifyAttendanceOpen = e.target.checked;
      const attToggle = document.getElementById("telegramAttendanceOpenToggle");
      if (attToggle) attToggle.checked = e.target.checked;
      const lbl = document.getElementById("telegramAttendanceOpenLabel");
      if (lbl) lbl.textContent = e.target.checked ? "Telegram Alert Active" : "Telegram Alert Paused";
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({ notify_attendance_open: e.target.checked });
      }
    });
  }

  const scanAttendanceBtn = document.getElementById("scanAttendanceBtn");
  if (scanAttendanceBtn) {
    scanAttendanceBtn.addEventListener("click", handleScanAttendanceNow);
  }

  const refreshSubmissionsBtn = document.getElementById("refreshSubmissionsBtn");
  if (refreshSubmissionsBtn) {
    refreshSubmissionsBtn.addEventListener("click", async () => {
      refreshSubmissionsBtn.disabled = true;
      refreshSubmissionsBtn.classList.add("spinning");
      try {
        await loadLiveDeadlines();
        showToast("Live submissions radar refreshed", "success");
      } catch (err) {
        showToast("Could not refresh live submissions", "error");
      } finally {
        refreshSubmissionsBtn.classList.remove("spinning");
        refreshSubmissionsBtn.disabled = false;
      }
    });
  }

  const toggleOccBtn = document.getElementById("toggleOccurrenceSetupBtn");
  const occForm = document.getElementById("occurrenceConfigForm");
  if (toggleOccBtn && occForm) {
    toggleOccBtn.addEventListener("click", () => {
      const isHidden = occForm.classList.toggle("hidden");
      const textEl = document.getElementById("occurrenceSetupToggleText");
      if (textEl) textEl.textContent = isHidden ? "Show Setup ⚙️" : "Hide Setup ✕";
    });
  }

  const occCourseSelect = document.getElementById("occurrenceCourseSelect");
  if (occCourseSelect) {
    occCourseSelect.addEventListener("change", updateOccurrenceInputField);
  }

  const saveOccBtn = document.getElementById("saveOccurrenceBtn");
  if (saveOccBtn) {
    saveOccBtn.addEventListener("click", handleSaveCourseOccurrence);
  }

  document.querySelectorAll(".occ-pill-btn").forEach((pill) => {
    pill.addEventListener("click", () => {
      const occInput = document.getElementById("occurrenceInput");
      if (occInput) {
        occInput.value = pill.dataset.occ || "";
        document.querySelectorAll(".occ-pill-btn").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
      }
    });
  });

  const attendanceSubjSelect = document.getElementById("attendanceSubjectSelect");
  if (attendanceSubjSelect) {
    attendanceSubjSelect.addEventListener("change", (e) => {
      state.selectedAttendanceSubject = e.target.value;
      renderAttendanceRecords();
    });
  }

  const submitOpenAttBtn = document.getElementById("submitOpenAttendanceBtn");
  if (submitOpenAttBtn) {
    submitOpenAttBtn.addEventListener("click", () => handleSubmitOpenAttendance());
  }

  // Interactive Password Accordion Drawer Toggle
  const togglePwdDrawerBtn = document.getElementById("togglePasswordDrawerBtn");
  const pwdWrap = document.getElementById("openAttendancePasswordWrap");
  if (togglePwdDrawerBtn && pwdWrap) {
    togglePwdDrawerBtn.addEventListener("click", () => {
      const isHidden = pwdWrap.classList.toggle("hidden");
      togglePwdDrawerBtn.classList.toggle("is-open", !isHidden);
      const arrow = document.getElementById("togglePasswordArrow");
      if (arrow) arrow.textContent = isHidden ? "▾" : "▴";
      const pwdInput = document.getElementById("openAttendancePasswordInput");
      if (!isHidden && pwdInput) pwdInput.focus();
    });
  }

  // Interactive Password Visibility Toggle
  const toggleOpenPwdVisBtn = document.getElementById("toggleOpenPwdVisBtn");
  const openPwdInput = document.getElementById("openAttendancePasswordInput");
  if (toggleOpenPwdVisBtn && openPwdInput) {
    toggleOpenPwdVisBtn.addEventListener("click", () => {
      const isPwd = openPwdInput.type === "password";
      openPwdInput.type = isPwd ? "text" : "password";
      toggleOpenPwdVisBtn.textContent = isPwd ? "🙈" : "👁️";
    });
  }

  if (openPwdInput) {
    openPwdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmitOpenAttendance();
      }
    });
  }

  // Interactive Copy Check-In Link Button
  const copyAttUrlBtn = document.getElementById("copyAttendanceUrlBtn");
  if (copyAttUrlBtn) {
    copyAttUrlBtn.addEventListener("click", async () => {
      const firstOpen = state.attendance?.openSessions?.[0];
      const url = firstOpen?.session?.submitUrl || firstOpen?.viewUrl || "https://spectrum.um.edu.my/my/";
      try {
        await navigator.clipboard.writeText(url);
        const icon = document.getElementById("copyUrlBtnIcon");
        if (icon) icon.textContent = "✓";
        showToast("Check-in link copied to clipboard!", "success");
        setTimeout(() => {
          if (icon) icon.textContent = "📋";
        }, 2200);
      } catch (e) {
        showToast("Could not copy link automatically.", "error");
      }
    });
  }

  // Interactive Preview / Simulator Toggle Button
  const testSubBtn = document.getElementById("testSubmissionContainerBtn");
  if (testSubBtn) {
    testSubBtn.addEventListener("click", () => {
      const banner = document.getElementById("openAttendanceBanner");
      if (!banner) return;
      const isHidden = banner.classList.contains("hidden");

      if (!isHidden && banner.dataset.simulated === "true") {
        banner.classList.add("hidden");
        delete banner.dataset.simulated;
        testSubBtn.textContent = "⚡ Preview Check-In";
        showToast("Preview closed.", "info");
        return;
      }

      const sampleCourse = state.courses?.[0] || { code: "WIX2002", name: "Project Management", id: "101" };
      const simulatedOpenSession = {
        courseId: sampleCourse.id,
        courseCode: sampleCourse.code,
        courseName: sampleCourse.name,
        occurrence: state.courseOccurrences[sampleCourse.id] || state.courseOccurrences[sampleCourse.code] || "Occ 1",
        viewUrl: `https://spectrum.um.edu.my/course/view.php?id=${sampleCourse.id}`,
        session: {
          sessid: "99881",
          description: "Lecture Session 08 (Interactive Check-In Demo)",
          time: "2:00 PM - 4:00 PM",
          status: "open",
          submitUrl: `https://spectrum.um.edu.my/mod/attendance/attendance.php?sessid=99881`
        }
      };

      if (!state.attendance) {
        state.attendance = { openSessions: [simulatedOpenSession], courses: [] };
      } else {
        state.attendance.openSessions = [simulatedOpenSession];
      }

      banner.dataset.simulated = "true";
      testSubBtn.textContent = "✕ Close Preview";
      renderOpenAttendanceBanner();
      showToast("Interactive Submission Container active! Click Submit to test.", "info");
    });
  }

  // Open Attendance Page Links
  const openAttendancePageLink = document.getElementById("openAttendancePageLink");
  if (openAttendancePageLink) {
    openAttendancePageLink.addEventListener("click", (e) => {
      e.preventDefault();
      const url = openAttendancePageLink.dataset.url || openAttendancePageLink.getAttribute("href");
      if (url) openExternalUrl(url);
    });
  }

  const openCourseAttBtn = document.getElementById("openCourseAttendancePageBtn");
  if (openCourseAttBtn) {
    openCourseAttBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const url = openCourseAttBtn.dataset.url || openCourseAttBtn.getAttribute("href");
      if (url) openExternalUrl(url);
    });
  }

  const openSpectrumHeaderBtn = document.getElementById("openSpectrumHeaderBtn");
  if (openSpectrumHeaderBtn) {
    openSpectrumHeaderBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const url = openSpectrumHeaderBtn.dataset.url || openSpectrumHeaderBtn.getAttribute("href") || "https://spectrum.um.edu.my/my/";
      openExternalUrl(url);
    });
  }

  const openSpectrumCalendarBtn = document.getElementById("openSpectrumCalendarBtn");
  if (openSpectrumCalendarBtn) {
    openSpectrumCalendarBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const url = openSpectrumCalendarBtn.getAttribute("href") || "https://spectrum.um.edu.my/calendar/view.php?view=upcoming";
      openExternalUrl(url);
    });
  }

  const attSessionsContainer = document.getElementById("attendanceSessionsList");
  if (attSessionsContainer) {
    attSessionsContainer.addEventListener("click", (e) => {
      const link = e.target.closest("a");
      if (link) {
        const url = link.dataset.url || link.getAttribute("href");
        if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
          e.preventDefault();
          openExternalUrl(url);
        }
      }
    });
  }

  const refreshAttBtn = document.getElementById("refreshAttendanceBtn");
  if (refreshAttBtn) {
    refreshAttBtn.addEventListener("click", async () => {
      refreshAttBtn.disabled = true;
      refreshAttBtn.textContent = "Scanning...";
      await loadLiveAttendanceData(true);
      refreshAttBtn.disabled = false;
      refreshAttBtn.textContent = "Check SPeCTRUM Attendance";
      showToast("Attendance updated!", "info");
    });
  }

  // Download Week Pack Button (guarded if removed or hidden)
  const downloadPackBtn = document.getElementById("downloadWeekPackBtn");
  if (downloadPackBtn) {
    downloadPackBtn.addEventListener("click", handleDownloadWeekPack);
  }

  // Settings: Password Visibility Toggle
  const toggleTokenBtn = document.getElementById("toggleTokenVisibility");
  const tokenInput = document.getElementById("telegramToken");
  if (toggleTokenBtn && tokenInput) {
    toggleTokenBtn.addEventListener("click", () => {
      if (tokenInput.type === "password") {
        tokenInput.type = "text";
        toggleTokenBtn.textContent = "🔒";
      } else {
        tokenInput.type = "password";
        toggleTokenBtn.textContent = "👁️";
      }
    });
  }

  // Settings: Test Buttons
  const testTelegramBtn = document.getElementById("testTelegramBtn");
  if (testTelegramBtn) {
    testTelegramBtn.addEventListener("click", handleTestTelegram);
  }
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", handleSaveSettings);
  }
  const autoDiscoverIcalBtn = document.getElementById("autoDiscoverIcalBtn");
  if (autoDiscoverIcalBtn) {
    autoDiscoverIcalBtn.addEventListener("click", handleAutoDiscoverIcal);
  }

  // Auto-update attendance tab whenever attendance is recorded or updated
  if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local") {
        if (changes.cached_attendance?.newValue) {
          state.attendance = changes.cached_attendance.newValue;
          renderAttendanceSummaryMetrics();
          renderOpenAttendanceBanner();
          renderAttendanceRecords();
        }
        if (changes.notify_attendance_open !== undefined) {
          const val = Boolean(changes.notify_attendance_open.newValue);
          state.notifyAttendanceOpen = val;
          const t = document.getElementById("telegramAttendanceOpenToggle");
          if (t) t.checked = val;
          const p = document.getElementById("prefAttendanceOpen");
          if (p) p.checked = val;
          const lbl = document.getElementById("telegramAttendanceOpenLabel");
          if (lbl) lbl.textContent = val ? "Telegram Alert Active" : "Telegram Alert Paused";
        }
      }
    });
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.action === "ATTENDANCE_SUBMITTED_SUCCESS" || message.action === "RECORD_ATTENDANCE_SUCCESS") {
        showToast("Attendance submitted! Marked as Present ✅", "success");
        const step3 = document.getElementById("stepperStep3");
        if (step3) {
          step3.className = "stepper-step step-done";
          const s3Icon = step3.querySelector(".stepper-icon");
          if (s3Icon) {
            s3Icon.textContent = "✓";
            s3Icon.classList.remove("stepper-pulse");
          }
        }
        const btnLabel = document.getElementById("submitBtnLabel");
        if (btnLabel) btnLabel.textContent = "Submitted as Present ✅";
        const btnIcon = document.getElementById("submitBtnIcon");
        if (btnIcon) btnIcon.textContent = "✓";
        setTimeout(() => {
          loadLiveAttendanceData(false).catch(() => {});
        }, 1200);
      }
    });
  }
}

function switchTab(tabName) {
  state.currentTab = tabName;

  document.querySelectorAll(".nav-tab-pill, .nav-tab").forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  document.querySelectorAll(".tab-content").forEach((panel) => {
    panel.classList.remove("active");
  });

  const activePanel = document.getElementById(`section${capitalize(tabName)}`);
  if (activePanel) {
    activePanel.classList.add("active");
  }

  if (tabName === "deadlines") {
    renderDeadlines();
    if (state.deadlines.length === 0 && state.isAuthenticated) {
      loadLiveDeadlines();
    }
  }

  if (tabName === "announcements") {
    populateAnnouncementSubjectDropdown();
    renderAnnouncements();
    if (state.announcements.length === 0 && state.isAuthenticated) {
      loadLiveAnnouncements();
    }
  }

  if (tabName === "attendance") {
    populateAttendanceCourseDropdowns();
    renderActiveOccurrenceBadges();
    renderAttendanceSummaryMetrics();
    renderOpenAttendanceBanner();
    renderAttendanceRecords();
    if (state.isAuthenticated && (!state.attendance || !state.attendance.courses || state.attendance.courses.length === 0)) {
      loadLiveAttendanceData(false);
    }
  }
}

// ===================================================================
// Auto-Login Tab Handler & Watcher
// ===================================================================
async function handleOpenLoginPortal() {
  const loginUrl = "https://spectrum.um.edu.my/login/index.php";

  const waitingBox = document.getElementById("loginWaitingBox");
  if (waitingBox) waitingBox.classList.remove("hidden");

  if (typeof chrome !== "undefined" && chrome.tabs) {
    chrome.tabs.create({ url: loginUrl }, (tab) => {
      state.loginTabId = tab.id;

      // Watch for tab updates (e.g. landing on /my/ or /auth/oidc/)
      const tabListener = (tabId, changeInfo) => {
        if (tabId === state.loginTabId && changeInfo.status === "complete") {
          // Check if tab has returned to SPeCTRUM
          chrome.tabs.get(tabId, async (updatedTab) => {
            if (updatedTab && updatedTab.url && updatedTab.url.includes("spectrum.um.edu.my") && !updatedTab.url.includes("login")) {
              console.log("[Spectra] SPeCTRUM login detected! Auto-reconnecting...");
              chrome.tabs.onUpdated.removeListener(tabListener);
              await syncLiveSession();
            }
          });
        }
      };

      chrome.tabs.onUpdated.addListener(tabListener);
    });
  } else {
    window.open(loginUrl, "_blank");
  }
}

// ===================================================================
// Live Session & Authentication Pipeline
// ===================================================================

/**
 * Update the explicit Settings status badge:
 * 🟢 Connected (Active session, verified against SPeCTRUM)
 * 🔴 Invalid / Expired (Redirected or unauthenticated)
 * ⚪ Unset (No session token configured)
 */
function updateAuthStatusBadge(status) {
  const badge = document.getElementById("session-status-badge");
  if (!badge) return;

  badge.className = "session-status-badge";
  if (status === "connected") {
    badge.classList.add("status-connected");
    badge.textContent = "🟢 Connected";
  } else if (status === "invalid" || status === "expired") {
    badge.classList.add("status-invalid");
    badge.textContent = "🔴 Invalid / Expired";
  } else {
    badge.classList.add("status-unset");
    badge.textContent = "⚪ Unset";
  }
}

/**
 * Toggle the inline notice cards on Deadlines and Class Prep tabs:
 * "Please provide your MoodleSession cookie in Settings to load courses."
 */
function updateInlineNoticeCards(isAuthenticated) {
  const noticeDeadlines = document.getElementById("sessionNoticeDeadlines");
  const noticeAnnouncements = document.getElementById("sessionNoticeAnnouncements");
  const noticeAttendance = document.getElementById("sessionNoticeAttendance");
  const noticeClassPrep = document.getElementById("sessionNoticeClassPrep");

  if (noticeDeadlines) {
    noticeDeadlines.classList.toggle("hidden", isAuthenticated);
  }
  if (noticeAnnouncements) {
    noticeAnnouncements.classList.toggle("hidden", isAuthenticated);
  }
  if (noticeAttendance) {
    noticeAttendance.classList.toggle("hidden", isAuthenticated);
  }
  if (noticeClassPrep) {
    noticeClassPrep.classList.toggle("hidden", isAuthenticated);
  }
}

/**
 * Render graceful unauthenticated empty states in Deadlines, Announcements, Attendance, and Class Prep
 */
function renderUnauthenticatedStates(isUnset) {
  const deadlinesList = document.getElementById("deadlinesList");
  const emptyState = document.getElementById("deadlinesEmptyState");
  const emptyMsg = document.getElementById("emptyStateMessage");

  if (deadlinesList) deadlinesList.innerHTML = "";
  if (emptyState && emptyMsg) {
    emptyMsg.textContent = isUnset
      ? "Please provide your MoodleSession cookie in Settings to load courses."
      : "Your SPeCTRUM session has expired. Please update your MoodleSession cookie in Settings.";
    emptyState.classList.remove("hidden");
  }

  const annList = document.getElementById("announcementsList");
  const annEmpty = document.getElementById("announcementsEmptyState");
  const annEmptyMsg = document.getElementById("emptyAnnouncementsMsg");
  if (annList) annList.innerHTML = "";
  if (annEmpty && annEmptyMsg) {
    annEmptyMsg.textContent = isUnset
      ? "Please connect your SPeCTRUM account in Settings to view course notices."
      : "Your SPeCTRUM session has expired. Please update your MoodleSession cookie in Settings.";
    annEmpty.classList.remove("hidden");
  }

  const attList = document.getElementById("attendanceSessionsList");
  const attEmpty = document.getElementById("attendanceEmptyState");
  const attEmptyMsg = document.getElementById("emptyAttendanceMsg");
  if (attList) attList.innerHTML = "";
  if (attEmpty && attEmptyMsg) {
    attEmptyMsg.textContent = isUnset
      ? "Please connect your SPeCTRUM account in Settings to view attendance records."
      : "Your SPeCTRUM session has expired. Please update your MoodleSession cookie in Settings.";
    attEmpty.classList.remove("hidden");
  }

  const courseSelect = document.getElementById("courseSelect");
  const coursesBadge = document.getElementById("detectedCoursesBadge");
  if (courseSelect) {
    courseSelect.innerHTML = `<option value="">${isUnset ? "Session required - configure in Settings" : "Session expired - please update in Settings"
      }</option>`;
  }
  if (coursesBadge) coursesBadge.textContent = "0 Courses";
}

/**
 * Quick jump link to the Settings tab and focus on the session input
 */
function jumpToSettingsTab() {
  switchTab("settings");
  const sessionInput = document.getElementById("moodle-session-input");
  if (sessionInput) {
    setTimeout(() => {
      sessionInput.focus();
      sessionInput.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }
}

/**
 * Toggle password masking on the MoodleSession input field
 */
function handleToggleSessionVisibility() {
  const input = document.getElementById("moodle-session-input");
  const btn = document.getElementById("toggle-moodle-session-visibility");
  if (!input || !btn) return;

  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "🔒";
    btn.setAttribute("title", "Hide token");
  } else {
    input.type = "password";
    btn.textContent = "👁️";
    btn.setAttribute("title", "Show token");
  }
}

/**
 * Hydrates state.deadlines from scraped calendar events and renders the Deadlines tab UI.
 * Supports both clean cached deadline items (events) and fallback raw Moodle action events (rawCalendarEvents).
 * Enforces student occurrence filtering, attendance exclusion, and preserves verified submission status.
 */
function hydrateDeadlinesFromScrape(events = [], rawCalendarEvents = []) {
  state.deadlines = normalizeHydratedDeadlines(events, rawCalendarEvents, {
    courseOccurrences: state.courseOccurrences,
    studentOccurrence: state.studentOccurrence,
    completedIds: state.completedIds
  });

  const loadingEl = document.getElementById("deadlinesLoading");
  if (loadingEl) loadingEl.classList.add("hidden");

  updateUrgentCountBadge();
  renderDeadlines();
}

/**
 * Hydrates state.courses from scraped course data and renders the course selector / week pills.
 * Supports both raw Moodle course items (rawCourses) and formatted table items (courses).
 */
async function hydrateCoursesFromScrape(courses = [], rawCourses = []) {
  const select = document.getElementById("courseSelect");
  const badge = document.getElementById("detectedCoursesBadge");

  if (Array.isArray(rawCourses) && rawCourses.length > 0) {
    state.courses = rawCourses.map((c) => {
      const code = extractCourseCode(c.shortname || c.fullname || "");
      return {
        id: String(c.id),
        code: code || "Course",
        name: c.fullname || code,
        shortname: c.shortname || code,
        url: c.viewurl || `https://spectrum.um.edu.my/course/view.php?id=${c.id}`
      };
    });
  } else if (Array.isArray(courses) && courses.length > 0) {
    state.courses = courses.map((c) => {
      const code = c.code || extractCourseCode(c["Code"] || c["Course Name"] || c.shortname || c.fullname || "");
      const name = c.name || c["Course Name"] || c.fullname || code;
      const id = String(c.id || c["ID"] || "");
      return {
        id,
        code: code || "Course",
        name: name || code,
        shortname: c.shortname || code,
        url: c.url || c.viewurl || c["URL"] || `https://spectrum.um.edu.my/course/view.php?id=${id}`
      };
    });
  } else {
    state.courses = [];
  }

  if (badge) badge.textContent = `${state.courses.length} Courses`;
  if (select) {
    select.innerHTML = "";
    if (state.courses.length === 0) {
      select.innerHTML = `<option value="">No enrolled courses detected on SPeCTRUM</option>`;
    } else {
      state.courses.forEach((c, idx) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `${c.code} - ${c.name}`;
        if (idx === 0) {
          opt.selected = true;
          state.selectedCourse = c;
        }
        select.appendChild(opt);
      });
    }
  }

  populateAnnouncementSubjectDropdown();
  populateAttendanceCourseDropdowns();
}

/**
 * Save & Test Connection handler:
 * - Validate string (non-empty alphanumeric, ~26 characters)
 * - Injects testSpectrumScraper directly into SPeCTRUM page tab
 * - Logs the user's 4-step scraping test into console
 * - Hydrates Deadlines and Enrolled Courses directly into the UI
 */
async function handleSaveAndTestSession() {
  const input = document.getElementById("moodle-session-input");
  const saveBtn = document.getElementById("save-session-btn");
  if (!input || !saveBtn) return;

  const rawToken = input.value.trim();

  // Validate non-empty
  if (!rawToken) {
    showToast("Please enter a MoodleSession cookie token", "error");
    updateAuthStatusBadge("unset");
    input.focus();
    return;
  }

  // Validate alphanumeric ~26 characters (15 to 45 chars)
  if (!/^[a-zA-Z0-9_-]{15,45}$/.test(rawToken)) {
    showToast("Invalid format. MoodleSession cookie is typically 26 alphanumeric characters.", "error");
    updateAuthStatusBadge("invalid");
    return;
  }

  const origHtml = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<span>Injecting & Scraping...</span>`;

  try {
    const verified = await saveManualSession(rawToken);

    // Update global state
    state.isAuthenticated = true;
    state.isDemoMode = false;
    state.sesskey = verified.sesskey;
    state.userName = verified.userName;
    state.userAvatarUrl = verified.userAvatarUrl || "";

    // Log the user's requested 4-step scraper outputs into popup console
    console.log("%c[1/4] Setting session cookie...", "color: #3b82f6; font-weight: bold;");
    console.log("%c[2/4] Testing dashboard access & extracting sesskey...", "color: #3b82f6; font-weight: bold;");
    console.log(`%c✔ Session Active! Welcome, ${verified.userName}`, "color: #10b981; font-weight: bold;");
    console.log(`%c✔ Extracted sesskey: ${verified.sesskey}`, "color: #10b981;");
    console.log("%c[3/4] Fetching live upcoming deadlines...", "color: #3b82f6; font-weight: bold;");
    if (verified.events && verified.events.length > 0) {
      console.log("%cUpcoming Deadlines:", "color: #10b981; font-weight: bold;");
      console.table(verified.events);
    } else {
      console.log("%cNo upcoming deadlines found.", "color: #f59e0b;");
    }
    console.log("%c[4/4] Fetching enrolled courses...", "color: #3b82f6; font-weight: bold;");
    if (verified.courses && verified.courses.length > 0) {
      console.log("%cEnrolled Courses:", "color: #10b981; font-weight: bold;");
      console.table(verified.courses);
    }
    console.log("%c✔ Scraping logic test complete.", "color: #10b981; font-weight: bold;");

    // Update UI Badges & Indicators
    updateAuthStatusBadge("connected");
    updateSessionIndicator("connected", "Connected");
    updateUserIdentityUI(verified.userName, verified.userAvatarUrl);
    updateInlineNoticeCards(true);
    setDisconnectedViewState(false);

    const studentDisplay = document.getElementById("studentNameDisplay");
    if (studentDisplay) studentDisplay.textContent = verified.userName;

    const sesskeyEl = document.getElementById("sesskeyDisplay");
    if (sesskeyEl) sesskeyEl.textContent = `${verified.sesskey.substring(0, 5)}••••••`;

    showToast("Session Injected & Scraping Complete!", "success");

    // Trigger live deadlines fetch directly from authoritative course pages
    try {
      await loadLiveDeadlines();
    } catch (e) {
      console.warn("[Spectra] Deadlines loading notice:", e);
    }

    try {
      if ((verified.rawCourses && verified.rawCourses.length > 0) || (verified.courses && verified.courses.length > 0)) {
        await hydrateCoursesFromScrape(verified.courses, verified.rawCourses);
      } else {
        await loadLiveEnrolledCourses();
      }
    } catch (e) {
      console.warn("[Spectra] Courses loading notice:", e);
    }

    try {
      // Load announcements
      await loadLiveAnnouncements();
    } catch (e) {
      console.warn("[Spectra] Announcements loading notice:", e);
    }

    // Auto-discover permanent Moodle iCal calendar feed in background if not already set
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get(["calendarIcalUrl", "calendar_ical_url"]).then((st) => {
        if (!st.calendarIcalUrl && !st.calendar_ical_url) {
          handleAutoDiscoverIcal(true);
        }
      }).catch(() => { });
    }

  } catch (err) {
    console.error("%c✖ Session Handshake Failed:", "color: #ef4444; font-weight: bold;", err.message || err);
    state.isAuthenticated = false;
    state.sesskey = null;

    updateAuthStatusBadge("invalid");
    updateSessionIndicator("disconnected", "Disconnected");
    updateInlineNoticeCards(false);

    showToast("Invalid Cookie, please re-check DevTools", "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = origHtml;
  }
}

/**
 * Auto-detect session from browser cookie store handler
 */
async function handleAutoDetectSession() {
  const autoBtn = document.getElementById("auto-detect-btn");
  const input = document.getElementById("moodle-session-input");
  if (!autoBtn) return;

  const origHtml = autoBtn.innerHTML;
  autoBtn.disabled = true;
  autoBtn.innerHTML = `<span>Auto-detecting...</span>`;

  try {
    const verified = await autoDetectSession();

    // Populate input field with detected cookie value
    if (input) {
      const stored = await chrome.storage.local.get(["manualMoodleSession"]);
      if (stored.manualMoodleSession) {
        input.value = stored.manualMoodleSession;
      }
    }

    // Update global state
    state.isAuthenticated = true;
    state.isDemoMode = false;
    state.sesskey = verified.sesskey;
    state.userName = verified.userName;
    state.userAvatarUrl = verified.userAvatarUrl || "";

    // Console logs matching scraper
    console.log("%c[1/4] Setting session cookie...", "color: #3b82f6; font-weight: bold;");
    console.log("%c[2/4] Testing dashboard access & extracting sesskey...", "color: #3b82f6; font-weight: bold;");
    console.log(`%c✔ Session Active! Welcome, ${verified.userName}`, "color: #10b981; font-weight: bold;");
    console.log(`%c✔ Extracted sesskey: ${verified.sesskey}`, "color: #10b981;");
    console.log("%c[3/4] Fetching live upcoming deadlines...", "color: #3b82f6; font-weight: bold;");
    if (verified.events && verified.events.length > 0) {
      console.log("%cUpcoming Deadlines:", "color: #10b981; font-weight: bold;");
      console.table(verified.events);
    } else {
      console.log("%cNo upcoming deadlines found.", "color: #f59e0b;");
    }
    console.log("%c[4/4] Fetching enrolled courses...", "color: #3b82f6; font-weight: bold;");
    if (verified.courses && verified.courses.length > 0) {
      console.log("%cEnrolled Courses:", "color: #10b981; font-weight: bold;");
      console.table(verified.courses);
    }
    console.log("%c✔ Scraping logic test complete.", "color: #10b981; font-weight: bold;");

    // Update UI Badges & Indicators
    updateAuthStatusBadge("connected");
    updateSessionIndicator("connected", "Connected");
    updateUserIdentityUI(verified.userName, verified.userAvatarUrl);
    updateInlineNoticeCards(true);
    setDisconnectedViewState(false);

    const studentDisplay = document.getElementById("studentNameDisplay");
    if (studentDisplay) studentDisplay.textContent = verified.userName;

    const sesskeyEl = document.getElementById("sesskeyDisplay");
    if (sesskeyEl) sesskeyEl.textContent = `${verified.sesskey.substring(0, 5)}••••••`;

    showToast("Session Auto-Detected Successfully!", "success");

    // Trigger live deadlines fetch directly from authoritative course pages
    try {
      await loadLiveDeadlines();
    } catch (e) {
      console.warn("[Spectra] Deadlines loading notice after auto-detect:", e);
    }

    try {
      if ((verified.rawCourses && verified.rawCourses.length > 0) || (verified.courses && verified.courses.length > 0)) {
        await hydrateCoursesFromScrape(verified.courses, verified.rawCourses);
      } else {
        await loadLiveEnrolledCourses();
      }
    } catch (e) {
      console.warn("[Spectra] Courses loading notice after auto-detect:", e);
    }

    try {
      // Load announcements
      await loadLiveAnnouncements();
    } catch (e) {
      console.warn("[Spectra] Announcements loading notice after auto-detect:", e);
    }
  } catch (err) {
    console.warn("[Spectra] Auto-detect session failed:", err);
    state.isAuthenticated = false;
    state.sesskey = null;

    const msg = err.message || "";
    if (msg.includes("No MoodleSession cookie found")) {
      updateAuthStatusBadge("unset");
      showToast("No active SPeCTRUM cookie in browser. Please sign in or paste cookie manually.", "error");
    } else {
      updateAuthStatusBadge("invalid");
      showToast("Invalid Cookie, please re-check DevTools", "error");
    }
  } finally {
    autoBtn.disabled = false;
    autoBtn.innerHTML = origHtml;
  }
}

/**
 * Live Session Discovery & Lightweight Verification Ping on Load
 */
async function syncLiveSession() {
  updateSessionIndicator("loading", "Connecting...");

  // 1. Check chrome.storage.local for manualMoodleSession and cached scraped data
  let manualToken = "";
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get([
        "manualMoodleSession",
        "manual_moodle_session",
        "cached_deadlines",
        "cached_courses",
        "cached_raw_courses",
        "cached_announcements",
        "cached_attendance",
        "verifiedSesskey",
        "userName",
        "userAvatarUrl",
        "course_occurrences",
        "courseOccurrences",
        "studentOccurrence",
        "completed_assignment_ids"
      ]);
      manualToken = (stored.manualMoodleSession || stored.manual_moodle_session || "").trim();

      if (stored.course_occurrences && typeof stored.course_occurrences === "object") {
        state.courseOccurrences = { ...state.courseOccurrences, ...stored.course_occurrences };
      }
      if (stored.courseOccurrences && typeof stored.courseOccurrences === "object") {
        state.courseOccurrences = { ...state.courseOccurrences, ...stored.courseOccurrences };
      }
      if (stored.studentOccurrence) {
        state.studentOccurrence = stored.studentOccurrence;
      }
      if (Array.isArray(stored.completed_assignment_ids)) {
        state.completedIds = new Set(stored.completed_assignment_ids.map(String));
      }

      // If we have cached scraped data, pre-hydrate the UI immediately for instant responsiveness!
      if (stored.userName) {
        state.userName = stored.userName;
        state.userAvatarUrl = stored.userAvatarUrl || "";
        updateUserIdentityUI(stored.userName, state.userAvatarUrl);
        const studentDisplay = document.getElementById("studentNameDisplay");
        if (studentDisplay) studentDisplay.textContent = stored.userName;
      }
      if (stored.verifiedSesskey) {
        state.sesskey = stored.verifiedSesskey;
        state.isAuthenticated = true;
        updateAuthStatusBadge("connected");
        updateSessionIndicator("connected", "Connected");
        const sesskeyEl = document.getElementById("sesskeyDisplay");
        if (sesskeyEl) sesskeyEl.textContent = `${stored.verifiedSesskey.substring(0, 5)}••••••`;
        updateInlineNoticeCards(true);
        setDisconnectedViewState(false);
      }
      if ((stored.cached_raw_courses && stored.cached_raw_courses.length > 0) || (stored.cached_courses && stored.cached_courses.length > 0)) {
        await hydrateCoursesFromScrape(stored.cached_courses, stored.cached_raw_courses);
      }

      // Explicitly purge legacy raw calendar cache to eliminate ghost tasks
      chrome.storage.local.remove(["cached_raw_events"]).catch(() => { });

      if (Array.isArray(stored.cached_deadlines)) {
        const cleanCached = stored.cached_deadlines.filter((d) => {
          if (!d || typeof d !== "object") return false;
          const title = (d.title || d.name || "").trim();
          if (!title) return false;
          if (d.dueTimestamp && isOverdueMoreThan40Days(d.dueTimestamp)) return false;
          const isSynthetic = (
            (d.id && String(d.id).startsWith("scraped-") && (!d.url || d.url.includes("/my/"))) ||
            (d.courseCode === "UM" && (!d.url || !d.url.includes("view.php?id=")))
          );
          return !isSynthetic;
        });

        const dedupedCached = deduplicateDeadlinesList(cleanCached, state.completedIds);

        if (dedupedCached.length !== stored.cached_deadlines.length) {
          chrome.storage.local.set({ cached_deadlines: dedupedCached }).catch(() => { });
        }

        if (dedupedCached.length > 0) {
          hydrateDeadlinesFromScrape(dedupedCached, []);
        } else {
          state.deadlines = [];
        }
      }
      if (Array.isArray(stored.cached_announcements) && stored.cached_announcements.length > 0) {
        state.announcements = stored.cached_announcements;
        populateAnnouncementSubjectDropdown();
        renderAnnouncements();
        const annLoad = document.getElementById("announcementsLoading");
        if (annLoad) annLoad.classList.add("hidden");
      }
      if (stored.cached_attendance && stored.cached_attendance.courses?.length > 0) {
        state.attendance = stored.cached_attendance;
        populateAttendanceCourseDropdowns();
        renderAttendanceSummaryMetrics();
        renderActiveOccurrenceBadges();
        renderOpenAttendanceBanner();
        renderAttendanceRecords();
        const attLoad = document.getElementById("attendanceLoading");
        if (attLoad) attLoad.classList.add("hidden");
      }
    } catch (e) {
      console.warn("[Spectra] Error loading cached data from storage:", e);
    }
  }

  // Populate input field if present in storage
  const inputEl = document.getElementById("moodle-session-input");
  if (inputEl && manualToken) {
    inputEl.value = manualToken;
  }

  // Update diagnostic box
  const diagSession = document.getElementById("diagSessionStatus");
  const storedCookie = manualToken || (await getStoredMoodleCookie());
  if (diagSession) {
    if (storedCookie) {
      diagSession.textContent = `Cookie Found (${storedCookie.substring(0, 5)}•••••)`;
      diagSession.className = "diag-val diag-ok";
    } else {
      diagSession.textContent = "No SPeCTRUM cookie configured";
      diagSession.className = "diag-val diag-warn";
    }
  }

  try {
    // Fast direct session verification (never opens background tabs)
    const sessionContext = await getSessionContext();

    state.isAuthenticated = true;
    state.isDemoMode = false;
    state.sesskey = sessionContext.sesskey;
    state.userName = sessionContext.userName;
    state.userAvatarUrl = sessionContext.userAvatarUrl || "";

    // Update UI Elements
    updateAuthStatusBadge("connected");
    updateSessionIndicator("connected", "Connected");
    updateUserIdentityUI(sessionContext.userName, sessionContext.userAvatarUrl);
    updateInlineNoticeCards(true);
    setDisconnectedViewState(false);

    // Update Settings displays
    const studentDisplay = document.getElementById("studentNameDisplay");
    if (studentDisplay) studentDisplay.textContent = sessionContext.userName;

    const sesskeyEl = document.getElementById("sesskeyDisplay");
    if (sesskeyEl) sesskeyEl.textContent = `${sessionContext.sesskey.substring(0, 5)}••••••`;

    // Step 1: Ensure enrolled courses are loaded first (non-blocking for session state)
    try {
      if (!state.courses || state.courses.length === 0) {
        await loadLiveEnrolledCourses();
      } else {
        loadLiveEnrolledCourses().catch((e) => console.warn("[Spectra] Background course refresh notice:", e));
      }
    } catch (courseErr) {
      console.warn("[Spectra] Course loading notice:", courseErr);
    }

    // Step 2: Load live deadlines with populated state.courses
    try {
      await loadLiveDeadlines();
    } catch (deadlineErr) {
      console.warn("[Spectra] Deadlines loading notice:", deadlineErr);
    }

    // Step 3: Pre-fetch live attendance in background
    try {
      loadLiveAttendanceData(false).catch((e) => console.warn("[Spectra] Attendance preload notice:", e));
    } catch (_) { }

  } catch (err) {
    console.warn("[Spectra] Live session authentication check:", err);
    state.isAuthenticated = false;
    state.sesskey = null;

    if (!state.isDemoMode) {
      const isUnset = err instanceof AuthRequiredError || err.name === "AUTH_REQUIRED" || !storedCookie;
      updateAuthStatusBadge(isUnset ? "unset" : "invalid");
      updateSessionIndicator("disconnected", isUnset ? "Unset" : "Session Expired");
      updateUserIdentityUI(isUnset ? "SPeCTRUM Unconnected" : "Session Expired", "");
      updateInlineNoticeCards(false);
      setDisconnectedViewState(false);
      renderUnauthenticatedStates(isUnset);
    }
  }
}

function updateSessionIndicator(status, label) {
  const sessionPill = document.getElementById("sessionPill");
  const sessionStatusText = document.getElementById("sessionStatusText");
  const cookieStatusLabel = document.getElementById("cookieStatusLabel");

  if (!sessionPill || !sessionStatusText) return;
  sessionPill.className = "session-pill";

  if (status === "connected") {
    sessionPill.classList.add("session-connected", "session-active");
    sessionStatusText.textContent = label;
    if (cookieStatusLabel) {
      cookieStatusLabel.textContent = "Live Moodle Active";
      cookieStatusLabel.className = "status-indicator-badge status-connected";
    }
  } else if (status === "loading") {
    sessionPill.classList.add("session-loading");
    sessionStatusText.textContent = label;
    if (cookieStatusLabel) {
      cookieStatusLabel.textContent = "Detecting...";
      cookieStatusLabel.className = "status-indicator-badge";
    }
  } else {
    sessionPill.classList.add("session-disconnected", "session-offline");
    sessionStatusText.textContent = label;
    if (cookieStatusLabel) {
      cookieStatusLabel.textContent = "Unauthenticated";
      cookieStatusLabel.className = "status-indicator-badge status-disconnected";
    }
  }
}

function updateUserIdentityUI(userName, avatarUrl) {
  const nameEl = document.getElementById("userName");
  const avatarEl = document.getElementById("userAvatar");
  const footerName = document.getElementById("studentNameDisplayFooter");

  if (nameEl) nameEl.textContent = userName;
  if (footerName) footerName.textContent = userName;

  if (avatarEl) {
    if (avatarUrl) {
      avatarEl.src = avatarUrl;
      avatarEl.classList.remove("hidden");
    } else {
      avatarEl.classList.add("hidden");
    }
  }
}

function setDisconnectedViewState(isDisconnected) {
  const disconnectedView = document.getElementById("sessionDisconnectedView");
  const mainContent = document.getElementById("mainContentContainer");

  if (!disconnectedView || !mainContent) return;

  // Always keep main content container visible so tabs and Settings are accessible
  mainContent.classList.remove("hidden");
  disconnectedView.classList.add("hidden");
}

// ===================================================================
// TAB 1: LIVE DEADLINES RADAR
// ===================================================================
async function loadLiveDeadlines() {
  const loadingEl = document.getElementById("deadlinesLoading");
  const listEl = document.getElementById("deadlinesList");
  const emptyEl = document.getElementById("deadlinesEmptyState");

  // Only show the loading spinner if we don't already have deadlines rendered!
  if (state.deadlines.length === 0 && (!listEl || listEl.children.length === 0)) {
    if (loadingEl) loadingEl.classList.remove("hidden");
  }
  if (emptyEl) emptyEl.classList.add("hidden");

  try {
    const liveEvents = await fetchLiveDeadlines(state.sesskey, state.courses, state.courseOccurrences, state.studentOccurrence);
    const filteredDeadlines = (liveEvents || []).filter((item) => {
      if (!item || typeof item !== "object") return false;
      if (isAttendanceActivity(item)) return false;
      if (isOverdueMoreThan40Days(item.dueTimestamp)) return false;
      const title = (item.title || item.name || "").trim();
      if (!title) return false;
      const isSynthetic = (
        (item.id && String(item.id).startsWith("scraped-") && (!item.url || item.url.includes("/my/"))) ||
        (item.courseCode === "UM" && (!item.url || !item.url.includes("view.php?id=")))
      );
      return !isSynthetic;
    });

    state.deadlines = deduplicateDeadlinesList(filteredDeadlines, state.completedIds);

    state.deadlines.sort((a, b) => {
      if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
      return a.dueTimestamp - b.dueTimestamp;
    });

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({ cached_deadlines: state.deadlines });
    }

    updateUrgentCountBadge();
    renderDeadlines();
  } catch (err) {
    console.error("[Spectra] Failed loading live deadlines:", err);
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION" || err.message?.includes("SESSION_EXPIRED")) {
      updateAuthStatusBadge("invalid");
      updateSessionIndicator("disconnected", "Session Expired");
      updateInlineNoticeCards(false);
      renderUnauthenticatedStates(false);
      showToast("Session Expired. Please update your MoodleSession cookie in Settings.", "error");
    } else {
      if (state.deadlines.length === 0) {
        showToast(`Error querying assignments: ${err.message}`, "error");
      }
    }
  } finally {
    if (loadingEl) loadingEl.classList.add("hidden");
  }
}

function updateUrgentCountBadge() {
  const urgentCount = state.deadlines.filter((d) => !d.isCompleted && d.urgency === "urgent").length;
  const urgentBadge = document.getElementById("urgentBadge");
  const urgentBanner = document.getElementById("urgentDeadlineBanner");
  const urgentBannerDetail = document.getElementById("urgentBannerDetail");

  if (urgentCount > 0) {
    if (urgentBadge) {
      urgentBadge.textContent = String(urgentCount);
      urgentBadge.classList.remove("hidden");
    }
    if (urgentBanner) {
      urgentBanner.classList.remove("hidden");
      urgentBannerDetail.textContent = `You have ${urgentCount} impending submission${urgentCount === 1 ? "" : "s"} due in less than 24 hours.`;
    }
  } else {
    if (urgentBadge) urgentBadge.classList.add("hidden");
    if (urgentBanner) urgentBanner.classList.add("hidden");
  }

  // Update filter pill counters strictly for submission tasks (exclude attendance and overdue > 40 days)
  const validSubmissions = state.deadlines.filter((d) => {
    if (isAttendanceActivity(d)) return false;
    if (isOverdueMoreThan40Days(d.dueTimestamp)) return false;
    return true;
  });
  const total = validSubmissions.length;
  const countUrgent = validSubmissions.filter((d) => !d.isCompleted && d.urgency === "urgent").length;
  const countWeek = validSubmissions.filter((d) => !d.isCompleted && d.urgency === "this_week").length;
  const countLater = validSubmissions.filter((d) => !d.isCompleted && d.urgency === "upcoming").length;
  const countDone = validSubmissions.filter((d) => d.isCompleted).length;

  document.getElementById("countAll").textContent = total;
  document.getElementById("countUrgent").textContent = countUrgent;
  document.getElementById("countWeek").textContent = countWeek;
  document.getElementById("countLater").textContent = countLater;
  document.getElementById("countDone").textContent = countDone;

  // Update Submissions Overview Information Container (matching Attendance overview design)
  const progressRate = total > 0 ? `${Math.round((countDone / total) * 100)}%` : "100%";
  const pendingCount = total - countDone;

  const progEl = document.getElementById("submissionsProgressRate");
  if (progEl) progEl.textContent = progressRate;
  const doneEl = document.getElementById("submissionsDoneCount");
  if (doneEl) doneEl.textContent = countDone;
  const wkEl = document.getElementById("submissionsWeekCount");
  if (wkEl) wkEl.textContent = countWeek;
  const urgEl = document.getElementById("submissionsUrgentCount");
  if (urgEl) urgEl.textContent = countUrgent;
  const pendEl = document.getElementById("submissionsPendingLabel");
  if (pendEl) {
    pendEl.textContent = `${pendingCount} Pending Submission${pendingCount === 1 ? "" : "s"}`;
  }
}

function renderDeadlines() {
  const container = document.getElementById("deadlinesList");
  const emptyState = document.getElementById("deadlinesEmptyState");
  if (!container) return;
  container.innerHTML = "";

  const filtered = state.deadlines.filter((item) => {
    // Strictly exclude any attendance items
    if (isAttendanceActivity(item)) return false;

    // Strictly exclude submissions overdue by more than 40 days
    if (isOverdueMoreThan40Days(item.dueTimestamp)) return false;

    if (state.searchQuery) {
      const matchTitle = item.title.toLowerCase().includes(state.searchQuery);
      const matchCourse = item.courseCode.toLowerCase().includes(state.searchQuery);
      if (!matchTitle && !matchCourse) return false;
    }

    if (state.activeFilter === "urgent") return !item.isCompleted && item.urgency === "urgent";
    if (state.activeFilter === "this_week") return !item.isCompleted && item.urgency === "this_week";
    if (state.activeFilter === "upcoming") return !item.isCompleted && item.urgency === "upcoming";
    if (state.activeFilter === "completed") return item.isCompleted;

    return true;
  });

  if (filtered.length === 0) {
    if (emptyState) {
      emptyState.classList.remove("hidden");
      const emptyMsg = document.getElementById("emptyStateMessage");
      if (state.deadlines.length === 0) {
        emptyMsg.textContent = "No upcoming assignments or submission dropboxes found on SPeCTRUM.";
      } else {
        emptyMsg.textContent = "No deadlines matching this filter criteria.";
      }
    }
    return;
  }
  if (emptyState) emptyState.classList.add("hidden");

  filtered.forEach((item) => {
    const card = document.createElement("div");
    card.id = `card_${item.id}`;

    const isSubmitted = Boolean(item.isSubmittedOnSpectrum || item.isCompleted);
    const now = Date.now();
    const diffMs = item.dueTimestamp ? (item.dueTimestamp - now) : null;
    const isUnder24Hr = !isSubmitted && item.dueTimestamp && (diffMs > 0 && diffMs <= 86400000);
    const isClosingTerm = item.dateLabel === "Closes" || item.type === "quiz";
    const dateLabelText = item.dateLabel
      ? `${item.dateLabel}:`
      : (item.type === "quiz" ? "Closes:" : "Due:");

    // Determine 3-state hierarchy requested by user:
    // 1. Green for Submitted
    // 2. Red for Under 24 hr
    // 3. Yellow for Pending
    let cardStateClass = "card-state-pending";
    let badgeHtml = "";
    let submissionChipHtml = "";
    let daysLeftBadge = "";

    if (isSubmitted) {
      cardStateClass = "card-state-submitted is-completed";
      badgeHtml = `<span class="urgency-badge badge-submitted"><span>✓</span> Submitted</span>`;
      daysLeftBadge = `<span class="due-days-pill pill-completed">✔ Done</span>`;
      submissionChipHtml = `
        <div class="submission-status-chip is-submitted" title="Submission recorded on SPeCTRUM">
          <span class="status-dot"></span>
          <span>${escapeHtml(item.submissionStatus || "Submitted")}</span>
        </div>
      `;
    } else if (isUnder24Hr || (!isSubmitted && item.urgency === "urgent" && diffMs > 0)) {
      cardStateClass = "card-state-urgent";
      badgeHtml = `<span class="urgency-badge badge-urgent"><span class="pulse-ring" style="width:10px;height:10px;position:static;"></span> &lt; 24h Left</span>`;
      const h = Math.floor(diffMs / 3600000);
      const m = Math.floor((diffMs % 3600000) / 60000);
      daysLeftBadge = `<span class="due-days-pill pill-urgent countdown-pill" data-timestamp="${item.dueTimestamp}">⚡ ${h}h ${m}m left</span>`;
      submissionChipHtml = `
        <div class="submission-status-chip is-urgent" title="Due in less than 24 hours">
          <span class="status-dot"></span>
          <span>Action Required (&lt;24h)</span>
        </div>
      `;
    } else {
      // Pending state: Yellow / Amber
      cardStateClass = "card-state-pending";
      if (diffMs !== null && diffMs <= 0) {
        const ovDays = Math.floor(Math.abs(diffMs) / 86400000);
        badgeHtml = `<span class="urgency-badge badge-pending"><span>⏳</span> Overdue ${ovDays > 0 ? `${ovDays}d` : ""}</span>`;
        daysLeftBadge = `<span class="due-days-pill pill-warning">⚠️ ${isClosingTerm ? "Closed" : "Overdue"} ${ovDays > 0 ? `${ovDays}d` : ""}</span>`;
        submissionChipHtml = `
          <div class="submission-status-chip is-pending" title="Pending submission">
            <span class="status-dot"></span>
            <span>${escapeHtml(item.submissionStatus || "Pending Submission")}</span>
          </div>
        `;
      } else if (item.urgency === "this_week") {
        badgeHtml = `<span class="urgency-badge badge-week"><span>🟡</span> This Week</span>`;
        const diffDays = Math.floor((diffMs || 0) / 86400000);
        daysLeftBadge = `<span class="due-days-pill pill-warning countdown-pill" data-timestamp="${item.dueTimestamp}">⏳ ${isClosingTerm ? "Closes" : "Due"} in ${diffDays}d</span>`;
        submissionChipHtml = `
          <div class="submission-status-chip is-pending" title="Due this week">
            <span class="status-dot"></span>
            <span>${escapeHtml(item.submissionStatus || "No submission")}</span>
          </div>
        `;
      } else {
        badgeHtml = `<span class="urgency-badge badge-upcoming"><span>⏳</span> Pending</span>`;
        if (item.dueTimestamp) {
          const diffDays = Math.floor((diffMs || 0) / 86400000);
          daysLeftBadge = `<span class="due-days-pill pill-warning countdown-pill" data-timestamp="${item.dueTimestamp}">⏳ ${isClosingTerm ? "Closes" : "Due"} in ${diffDays}d</span>`;
        } else {
          daysLeftBadge = `<span class="due-days-pill pill-normal">Open</span>`;
        }
        submissionChipHtml = `
          <div class="submission-status-chip is-pending" title="Pending submission">
            <span class="status-dot"></span>
            <span>${escapeHtml(item.submissionStatus || "No submission")}</span>
          </div>
        `;
      }
    }

    card.className = `deadline-card ${cardStateClass} tier-${item.urgency}`;

    const formattedDueDate = formatDueCalendarDate(item.dueTimestamp, item.formattedTime);
    const isTgSent = state.telegramSentDeadlineIds.has(String(item.id)) || item.telegramSent;
    const tgSentBadge = isTgSent ? `<span class="telegram-sent-tag" title="Alert flagged as sent to Telegram">✈️ Telegram Sent</span>` : "";

    const typeLabel = item.type === "quiz" ? "Quiz" : (item.type === "turnitin" ? "Turnitin" : (item.type === "workshop" ? "Workshop" : "Assignment"));
    const typeBadge = `<span class="activity-type-tag type-${item.type || "assign"}">${typeLabel}</span>`;
    const studentOcc = state.courseOccurrences[item.courseCode] || state.courseOccurrences[item.courseId] || "";
    const occBadge = studentOcc ? `<span class="occ-target-tag" title="Filtered for your registered occurrence">${escapeHtml(studentOcc)}</span>` : "";

    card.innerHTML = `
      <div class="deadline-card-header">
        <div class="course-badge-row">
          <span class="course-tag">${escapeHtml(item.courseCode)}</span>
          ${typeBadge}
          ${occBadge}
          ${item.weight ? `<span class="weight-tag">${escapeHtml(item.weight)}</span>` : ""}
          ${tgSentBadge}
        </div>
        ${badgeHtml}
      </div>

      <div class="assignment-title">${escapeHtml(item.title)}</div>

      <div class="deadline-due-meta">
        <div class="due-calendar-info" title="Submission deadline">
          <svg viewBox="0 0 20 20" width="13" height="13" fill="currentColor" class="due-calendar-icon">
            <path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/>
          </svg>
          <span class="due-date-label">${escapeHtml(dateLabelText)}</span>
          <span class="due-date-value">${escapeHtml(formattedDueDate)}</span>
        </div>
        ${daysLeftBadge}
      </div>

      <div class="deadline-card-footer">
        ${submissionChipHtml}

        <div class="card-actions">
          <a href="${escapeHtml(item.url)}" target="_blank" class="link-launch-btn" title="Open in SPeCTRUM">
            <span>Dropbox</span>
            <svg viewBox="0 0 20 20" width="11" height="11" fill="currentColor">
              <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/>
              <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/>
            </svg>
          </a>

          <label class="custom-checkbox-wrap" title="Mark as submitted/completed">
            <input type="checkbox" class="deadline-checkbox" data-id="${escapeHtml(item.id)}" ${item.isCompleted ? "checked" : ""}>
            <span class="checkbox-visual"></span>
          </label>
        </div>
      </div>
    `;

    const checkbox = card.querySelector(".deadline-checkbox");
    checkbox.addEventListener("change", async (e) => {
      const isChecked = e.target.checked;
      const targetId = e.target.dataset.id;
      const found = state.deadlines.find((d) => d.id === targetId || d.cmid === targetId);

      if (isChecked) {
        state.completedIds.add(targetId);
        if (found?.cmid) state.completedIds.add(String(found.cmid));
      } else {
        state.completedIds.delete(targetId);
        if (found?.cmid) state.completedIds.delete(String(found.cmid));
      }

      if (found) found.isCompleted = isChecked;

      state.deadlines = deduplicateDeadlinesList(state.deadlines, state.completedIds);

      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          completed_assignment_ids: Array.from(state.completedIds),
          cached_deadlines: state.deadlines
        });
      }

      updateUrgentCountBadge();
      renderDeadlines();
      showToast(isChecked ? "Marked as completed!" : "Marked as pending", "info");
    });

    container.appendChild(card);
  });
}

function startLiveCountdowns() {
  if (state.countdownIntervalId) clearInterval(state.countdownIntervalId);

  state.countdownIntervalId = setInterval(() => {
    document.querySelectorAll(".countdown-text").forEach((el) => {
      const ts = parseInt(el.dataset.timestamp, 10);
      if (!isNaN(ts)) {
        el.textContent = formatTimeRemaining(ts);
      }
    });
  }, 30000);
}

// ===================================================================
// TAB 2: LIVE COURSE ANNOUNCEMENTS
// ===================================================================

/**
 * Loads live forum announcements for all enrolled courses
 */
async function loadLiveAnnouncements() {
  const loadingEl = document.getElementById("announcementsLoading");
  const listEl = document.getElementById("announcementsList");
  const emptyEl = document.getElementById("announcementsEmptyState");

  // Only show loading spinner if we don't already have announcements rendered!
  if (state.announcements.length === 0 && (!listEl || listEl.children.length === 0)) {
    if (loadingEl) loadingEl.classList.remove("hidden");
  }
  if (emptyEl) emptyEl.classList.add("hidden");

  try {
    let announcements = [];

    // 1. Check if cached_announcements exists in storage
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(["cached_announcements", "telegram_sent_announcement_ids"]);
      if (Array.isArray(stored.telegram_sent_announcement_ids)) {
        state.telegramSentAnnouncementIds = new Set(stored.telegram_sent_announcement_ids.map(String));
      }
      if (Array.isArray(stored.cached_announcements) && stored.cached_announcements.length > 0) {
        announcements = stored.cached_announcements;
        announcements.sort((a, b) => {
          const tsA = a.timestamp || parseNoticeTimestamp(a.date, a.id) || 0;
          const tsB = b.timestamp || parseNoticeTimestamp(b.date, b.id) || 0;
          if (tsA !== tsB) return tsB - tsA;
          const idA = parseInt(a.id, 10) || 0;
          const idB = parseInt(b.id, 10) || 0;
          return idB - idA;
        });
        state.announcements = announcements;
        populateAnnouncementSubjectDropdown();
        renderAnnouncements();
        if (loadingEl) loadingEl.classList.add("hidden");
      }
    }

    // 2. If no cached announcements, fetch live
    if (announcements.length === 0) {
      if (state.courses && state.courses.length > 0) {
        announcements = await fetchLiveAnnouncements(state.courses, state.sesskey);
      } else {
        const courses = await getLiveEnrolledCourses(state.sesskey);
        state.courses = courses;
        announcements = await fetchLiveAnnouncements(courses, state.sesskey);
      }

      announcements = announcements.map((a) => ({
        ...a,
        telegramSent: state.telegramSentAnnouncementIds.has(String(a.id))
      }));

      announcements.sort((a, b) => {
        const tsA = a.timestamp || parseNoticeTimestamp(a.date, a.id) || 0;
        const tsB = b.timestamp || parseNoticeTimestamp(b.date, b.id) || 0;
        if (tsA !== tsB) return tsB - tsA;
        const idA = parseInt(a.id, 10) || 0;
        const idB = parseInt(b.id, 10) || 0;
        return idB - idA;
      });

      if (typeof chrome !== "undefined" && chrome.storage?.local && announcements.length > 0) {
        await chrome.storage.local.set({ cached_announcements: announcements });
      }

      state.announcements = announcements;
      populateAnnouncementSubjectDropdown();
      renderAnnouncements();
    }
  } catch (err) {
    console.error("[Spectra] Error loading live announcements:", err);
    if (state.announcements.length === 0) {
      if (listEl) listEl.innerHTML = "";
      if (emptyEl) {
        emptyEl.classList.remove("hidden");
        const emptyMsg = document.getElementById("emptyAnnouncementsMsg");
        if (emptyMsg) emptyMsg.textContent = "Could not fetch announcements from SPeCTRUM forums.";
      }
    }
  } finally {
    if (loadingEl) loadingEl.classList.add("hidden");
  }
}

/**
 * Populate the course subject dropdown for filtering announcements
 */
function populateAnnouncementSubjectDropdown() {
  const select = document.getElementById("announcementSubjectSelect");
  if (!select) return;

  const currentVal = state.selectedAnnouncementSubject || "all";
  select.innerHTML = `<option value="all">📚 All Enrolled Subjects</option>`;

  const courseMap = new Map();
  if (Array.isArray(state.courses)) {
    state.courses.forEach((c) => {
      const code = c.code || c.shortname;
      if (code && !courseMap.has(code)) {
        courseMap.set(code, c.name || code);
      }
    });
  }

  if (Array.isArray(state.announcements)) {
    state.announcements.forEach((a) => {
      if (a.courseCode && !courseMap.has(a.courseCode)) {
        courseMap.set(a.courseCode, a.courseCode);
      }
    });
  }

  courseMap.forEach((name, code) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `🎓 ${code} - ${name}`;
    if (code === currentVal) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  const hintEl = document.getElementById("announcementSubjectHint");
  if (hintEl) {
    hintEl.textContent = currentVal === "all" ? `${courseMap.size} Courses` : currentVal;
  }
}

/**
 * Render filtered course announcements list
 */
function renderAnnouncements() {
  const container = document.getElementById("announcementsList");
  const emptyState = document.getElementById("announcementsEmptyState");
  const countBadge = document.getElementById("announcementsTotalCountBadge");
  const navBadge = document.getElementById("announcementsBadge");
  const hintEl = document.getElementById("announcementSubjectHint");

  if (!container) return;
  container.innerHTML = "";

  const selectedSubject = state.selectedAnnouncementSubject || "all";
  if (hintEl) {
    hintEl.textContent = selectedSubject === "all" ? "All Subjects" : selectedSubject;
  }

  const filtered = state.announcements.filter((item) => {
    if (selectedSubject === "all") return true;
    return item.courseCode === selectedSubject;
  });

  // Sort notices starting with the latest (most recent first)
  filtered.sort((a, b) => {
    const tsA = a.timestamp || parseNoticeTimestamp(a.date, a.id) || 0;
    const tsB = b.timestamp || parseNoticeTimestamp(b.date, b.id) || 0;
    if (tsA !== tsB) return tsB - tsA;
    const idA = parseInt(a.id, 10) || 0;
    const idB = parseInt(b.id, 10) || 0;
    return idB - idA;
  });

  if (countBadge) {
    countBadge.textContent = `${filtered.length} Notice${filtered.length === 1 ? "" : "s"}`;
  }
  if (navBadge) {
    if (state.announcements.length > 0) {
      navBadge.textContent = String(state.announcements.length);
      navBadge.classList.remove("hidden");
    } else {
      navBadge.classList.add("hidden");
    }
  }

  if (filtered.length === 0) {
    if (emptyState) {
      emptyState.classList.remove("hidden");
      const emptyMsg = document.getElementById("emptyAnnouncementsMsg");
      if (emptyMsg) {
        emptyMsg.textContent = selectedSubject === "all"
          ? "No forum announcements found on SPeCTRUM for your courses."
          : `No forum announcements found for ${selectedSubject}.`;
      }
    }
    return;
  }

  if (emptyState) emptyState.classList.add("hidden");

  filtered.forEach((item) => {
    const card = document.createElement("article");
    card.className = "announcement-card";

    const isTgSent = state.telegramSentAnnouncementIds.has(String(item.id)) || item.telegramSent;
    const tgSentBadge = isTgSent ? `<span class="telegram-sent-tag" title="Notice flagged as sent to Telegram">✈️ Telegram Sent</span>` : "";

    card.innerHTML = `
      <div class="announcement-card-header">
        <div class="flex-align-center" style="gap: 6px;">
          <span class="announcement-course-pill">${item.courseCode || "UM"}</span>
          ${tgSentBadge}
        </div>
        <span class="announcement-date-text">🕒 ${item.date || "Recent"}</span>
      </div>
      <h4 class="announcement-subject-title">${item.subject}</h4>
      <div class="announcement-footer">
        <span class="announcement-author-info">👤 ${item.author || "Course Instructor"}</span>
        <a href="${item.url || 'https://spectrum.um.edu.my/'}" target="_blank" rel="noopener noreferrer" class="announcement-link-btn">
          Open Notice &rarr;
        </a>
      </div>
    `;

    container.appendChild(card);
  });
}

// ===================================================================
// TAB 3: LIVE ATTENDANCE TRACKER & AUTO-CHECKIN
// ===================================================================

/**
 * Loads live attendance records for all enrolled courses
 */
async function loadLiveAttendanceData(force = false) {
  const loadingEl = document.getElementById("attendanceLoading");
  const listEl = document.getElementById("attendanceSessionsList");
  const emptyEl = document.getElementById("attendanceEmptyState");

  // Only show loading spinner if attendance is not yet loaded in state
  if (!state.attendance) {
    if (loadingEl) loadingEl.classList.remove("hidden");
  }
  if (emptyEl) emptyEl.classList.add("hidden");

  try {
    let attendanceData = null;

    // 1. Check cached_attendance if not forcing refresh and cache is fresh (< 5 mins)
    if (!force && typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(["cached_attendance", "last_attendance_sync"]);
      const age = Date.now() - (stored.last_attendance_sync || 0);
      if (age < 300000 && stored.cached_attendance && stored.cached_attendance.courses?.length > 0) {
        attendanceData = stored.cached_attendance;
        state.attendance = attendanceData;
        populateAttendanceCourseDropdowns();
        renderAttendanceSummaryMetrics();
        renderActiveOccurrenceBadges();
        renderOpenAttendanceBanner();
        renderAttendanceRecords();
        if (loadingEl) loadingEl.classList.add("hidden");
        return;
      }
    }

    // 2. Fetch live if not in cache or forced or cache expired
    if (!attendanceData) {
      if (!state.courses || state.courses.length === 0) {
        state.courses = await getLiveEnrolledCourses(state.sesskey);
      }

      attendanceData = await fetchLiveAllAttendance(state.courses, state.sesskey, state.courseOccurrences);

      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          cached_attendance: attendanceData,
          last_attendance_sync: Date.now()
        });
      }
    }

    state.attendance = attendanceData;
    populateAttendanceCourseDropdowns();
    renderAttendanceSummaryMetrics();
    renderActiveOccurrenceBadges();
    renderOpenAttendanceBanner();
    renderAttendanceRecords();
  } catch (err) {
    console.error("[Spectra] Error loading live attendance:", err);
    if (!state.attendance) {
      if (listEl) listEl.innerHTML = "";
      if (emptyEl) {
        emptyEl.classList.remove("hidden");
        const emptyMsg = document.getElementById("emptyAttendanceMsg");
        if (emptyMsg) emptyMsg.textContent = "Could not fetch attendance from SPeCTRUM.";
      }
    }
  } finally {
    if (loadingEl) loadingEl.classList.add("hidden");
  }
}

/**
 * Populates occurrence course select & attendance view filter select
 */
function populateAttendanceCourseDropdowns() {
  const occSelect = document.getElementById("occurrenceCourseSelect");
  const viewSelect = document.getElementById("attendanceSubjectSelect");

  if (occSelect && Array.isArray(state.courses)) {
    const prevVal = occSelect.value;
    occSelect.innerHTML = `<option value="">-- Choose Course to Set Occurrence --</option>`;
    state.courses.forEach((c) => {
      const code = c.code || c.shortname;
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `🎓 ${code} - ${c.name}`;
      if (c.id === prevVal) opt.selected = true;
      occSelect.appendChild(opt);
    });

    if (!occSelect.value && state.courses.length > 0) {
      occSelect.value = state.courses[0].id;
    }
    updateOccurrenceInputField();
  }

  if (viewSelect) {
    const prevSubject = state.selectedAttendanceSubject || "all";
    viewSelect.innerHTML = `<option value="all">📚 All Enrolled Subjects</option>`;

    if (Array.isArray(state.courses)) {
      state.courses.forEach((c) => {
        const code = c.code || c.shortname;
        const occ = state.courseOccurrences[c.id] || state.courseOccurrences[code] || "";
        const occTag = occ ? ` (${occ})` : " (Occ not set)";
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `🎓 ${code}${occTag} - ${c.name}`;
        if (c.id === prevSubject) opt.selected = true;
        viewSelect.appendChild(opt);
      });
    }
  }
}

/**
 * Update occurrence input and hint label based on selected course
 */
function updateOccurrenceInputField() {
  const occSelect = document.getElementById("occurrenceCourseSelect");
  const occInput = document.getElementById("occurrenceInput");
  const occLabel = document.getElementById("currentCourseOccLabel");
  if (!occSelect || !occInput) return;

  const courseId = occSelect.value;
  const course = state.courses.find((c) => String(c.id) === String(courseId));
  const code = course?.code || "";
  const existingOcc = state.courseOccurrences[courseId] || state.courseOccurrences[code] || "";

  occInput.value = existingOcc;
  if (occLabel) {
    occLabel.textContent = existingOcc ? `Current: ${existingOcc}` : "Not Set";
  }
}

/**
 * Render chips for configured course occurrences
 */
function renderActiveOccurrenceBadges() {
  const container = document.getElementById("activeOccurrencesList");
  if (!container) return;
  container.innerHTML = "";

  if (!Array.isArray(state.courses) || state.courses.length === 0) {
    container.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">No enrolled courses detected.</span>`;
    return;
  }

  state.courses.forEach((c) => {
    const code = c.code || c.shortname;
    const occ = state.courseOccurrences[c.id] || state.courseOccurrences[code];

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `occ-chip ${occ ? "occ-set" : ""}`;
    chip.innerHTML = `
      <span class="occ-chip-code">${code}</span>
      <span>${occ ? `🏷️ ${occ}` : "⚠️ Set Occ"}</span>
    `;

    chip.addEventListener("click", () => {
      const occSelect = document.getElementById("occurrenceCourseSelect");
      if (occSelect) {
        occSelect.value = c.id;
        updateOccurrenceInputField();
        const occInput = document.getElementById("occurrenceInput");
        if (occInput) occInput.focus();
      }
    });

    container.appendChild(chip);
  });

  const deadlinesTag = document.getElementById("activeOccDeadlinesTag");
  if (deadlinesTag) {
    const configuredCount = state.courses.filter(c => state.courseOccurrences[c.id] || state.courseOccurrences[c.code || c.shortname]).length;
    if (configuredCount > 0) {
      deadlinesTag.textContent = `🎯 ${configuredCount}/${state.courses.length} Courses Filtered`;
    } else {
      deadlinesTag.textContent = `⚠️ All Occurrences`;
    }
  }
}

/**
 * Render overall attendance metrics grid & rate badge
 */
function renderAttendanceSummaryMetrics() {
  const rateBadge = document.getElementById("attendanceOverallRateBadge");
  const overallRateEl = document.getElementById("attendanceOverallScore") || document.getElementById("attendanceOverallRate");
  const presentEl = document.getElementById("attendancePresentCount");
  const lateEl = document.getElementById("attendanceLateCount");
  const absentEl = document.getElementById("attendanceAbsentCount");
  const navBadge = document.getElementById("attendanceBadge");

  const summary = state.attendance?.summary || {
    overallPercentage: "100.0%",
    totalPresent: 0,
    totalLate: 0,
    totalAbsent: 0,
    openSessionsCount: 0
  };

  const pct = summary.overallPercentage || "100.0%";
  if (rateBadge) rateBadge.textContent = `${pct} Rate`;
  if (overallRateEl) overallRateEl.textContent = pct;
  if (presentEl) presentEl.textContent = summary.totalPresent ?? 0;
  if (lateEl) lateEl.textContent = summary.totalLate ?? 0;
  if (absentEl) absentEl.textContent = summary.totalAbsent ?? 0;

  if (navBadge) {
    if (summary.openSessionsCount > 0) {
      navBadge.textContent = "OPEN";
      navBadge.classList.remove("hidden");
    } else {
      navBadge.classList.add("hidden");
    }
  }
}

/**
 * Render open attendance check-in banner if a session is currently active
 */
function renderOpenAttendanceBanner() {
  const banner = document.getElementById("openAttendanceBanner");
  if (!banner) return;

  const openList = state.attendance?.openSessions || [];
  if (openList.length === 0) {
    banner.classList.add("hidden");
    return;
  }

  const firstOpen = openList[0];
  const courseCodeEl = document.getElementById("openAttendanceCourseCode");
  const occBadgeEl = document.getElementById("openAttendanceOccBadge");
  const timeBadge = document.getElementById("openAttendanceTimeBadge");
  const titleEl = document.getElementById("openAttendanceTitle");
  const descEl = document.getElementById("openAttendanceDesc");
  const openLink = document.getElementById("openAttendancePageLink");
  const btnIcon = document.getElementById("submitBtnIcon");
  const btnLabel = document.getElementById("submitBtnLabel");
  const step1 = document.getElementById("stepperStep1");
  const step2 = document.getElementById("stepperStep2");
  const step3 = document.getElementById("stepperStep3");

  if (courseCodeEl) courseCodeEl.textContent = firstOpen.courseCode || "UM Course";
  if (occBadgeEl) {
    const rawOcc = firstOpen.occurrence || state.courseOccurrences[firstOpen.courseId] || state.courseOccurrences[firstOpen.courseCode] || "All Occ";
    occBadgeEl.textContent = rawOcc.toLowerCase().includes("all") ? "All Occ" : (rawOcc.toLowerCase().includes("occ") ? rawOcc : `Occ ${rawOcc.replace(/\D+/g, "") || rawOcc}`);
  }
  if (timeBadge) timeBadge.textContent = firstOpen.session?.time || "OPEN NOW";
  if (titleEl) titleEl.textContent = firstOpen.session?.description || "Lecture Session Check-In Open";
  if (descEl) {
    descEl.textContent = `Matches your registered occurrence. Click Submit to auto-navigate & mark Present.`;
  }

  // Reset interactive button state
  if (btnIcon && btnLabel) {
    btnIcon.textContent = "⚡";
    btnLabel.textContent = "Submit (Mark Present) →";
  }

  // Reset interactive stepper
  if (step1 && step2 && step3) {
    step1.className = "stepper-step step-done";
    step1.querySelector(".stepper-icon").textContent = "✓";
    step2.className = "stepper-step step-current";
    const s2Icon = step2.querySelector(".stepper-icon");
    s2Icon.textContent = "2";
    s2Icon.classList.add("stepper-pulse");
    step3.className = "stepper-step step-pending";
    const s3Icon = step3.querySelector(".stepper-icon");
    s3Icon.textContent = "🤖";
    s3Icon.classList.remove("stepper-pulse");
  }

  const targetUrl = firstOpen.session?.submitUrl || firstOpen.viewUrl || (firstOpen.cmid ? `https://spectrum.um.edu.my/mod/attendance/view.php?id=${firstOpen.cmid}` : "https://spectrum.um.edu.my/mod/attendance/view.php");
  if (openLink) {
    openLink.href = targetUrl;
    openLink.dataset.url = targetUrl;
  }

  banner.classList.remove("hidden");
}

/**
 * Render filtered attendance session history records
 */
function renderAttendanceRecords() {
  const container = document.getElementById("attendanceSessionsList") || document.getElementById("attendanceLogContainer");
  const emptyState = document.getElementById("attendanceEmptyState");
  const countBadge = document.getElementById("attendanceSessionsCountBadge");
  const statsBar = document.getElementById("subjectAttendanceStatsBar");
  const occBadge = document.getElementById("selectedSubjectOccBadge");
  const openCourseAttBtn = document.getElementById("openCourseAttendancePageBtn");
  const countUpcomingEl = document.getElementById("countAttUpcoming");
  const countHistoryEl = document.getElementById("countAttHistory");
  const countAllEl = document.getElementById("countAttAll");

  if (!container) return;
  container.innerHTML = "";

  const selected = state.selectedAttendanceSubject || "all";
  let targetCourses = state.attendance?.courses || [];

  if (selected !== "all") {
    targetCourses = targetCourses.filter((c) => String(c.courseId) === String(selected));
  }

  // Update Occurrence badge & Open Attendance Page button
  if (occBadge) {
    if (selected === "all") {
      occBadge.textContent = "All Enrolled Subjects";
    } else {
      const c = state.courses.find((x) => String(x.id) === String(selected));
      const code = c?.code || "";
      const occ = state.courseOccurrences[selected] || state.courseOccurrences[code];
      occBadge.textContent = occ ? `Occurrence: ${occ}` : "Occ not set";
    }
  }

  if (openCourseAttBtn) {
    if (selected !== "all" && targetCourses.length > 0) {
      const targetC = targetCourses[0];
      const courseViewUrl = targetC.viewUrl || (targetC.cmid ? `https://spectrum.um.edu.my/mod/attendance/view.php?id=${targetC.cmid}` : `https://spectrum.um.edu.my/course/view.php?id=${targetC.courseId}`);
      openCourseAttBtn.href = courseViewUrl;
      openCourseAttBtn.dataset.url = courseViewUrl;
      openCourseAttBtn.textContent = `Open ${targetC.courseCode} Attendance ↗`;
    } else {
      const firstCourseWithUrl = targetCourses.find((c) => c.viewUrl);
      const defaultUrl = firstCourseWithUrl?.viewUrl || "https://spectrum.um.edu.my/my/";
      openCourseAttBtn.href = defaultUrl;
      openCourseAttBtn.dataset.url = defaultUrl;
      openCourseAttBtn.textContent = "Open Attendance Page ↗";
    }
  }

  // Handle selected subject stats bar
  if (selected !== "all" && targetCourses.length > 0) {
    const courseRecord = targetCourses[0];
    if (statsBar) {
      statsBar.classList.remove("hidden");
      const nameEl = document.getElementById("subjectStatsCourseName");
      const rateEl = document.getElementById("subjectStatsRate");
      const barFill = document.getElementById("subjectStatsProgressBar");
      const detailEl = document.getElementById("subjectStatsDetail");
      const ptsEl = document.getElementById("subjectStatsPoints");

      const pctStr = courseRecord.summary?.percentage || "100.0%";
      const numPct = parseFloat(pctStr) || 100;

      if (nameEl) nameEl.textContent = courseRecord.courseCode || "Course";
      if (rateEl) rateEl.textContent = pctStr;
      if (barFill) barFill.style.width = `${Math.min(100, Math.max(0, numPct))}%`;
      if (detailEl) detailEl.textContent = `${courseRecord.summary?.takenSessions || 0} Sessions Recorded`;
      if (ptsEl) ptsEl.textContent = `${courseRecord.summary?.points || "0 / 0"} pts`;
    }
  } else {
    if (statsBar) statsBar.classList.add("hidden");
  }

  // Flatten sessions with courseViewUrl (STRICT: only show attendance according to occurrence for each subject)
  const allMatchingSessions = [];
  targetCourses.forEach((c) => {
    const configuredOcc = state.courseOccurrences[c.courseId] || state.courseOccurrences[c.courseCode] || c.occurrence || "";
    const hasConfiguredOcc = Boolean(configuredOcc && configuredOcc.trim().toLowerCase() !== "all");
    const cViewUrl = c.viewUrl || (c.cmid ? `https://spectrum.um.edu.my/mod/attendance/view.php?id=${c.cmid}` : `https://spectrum.um.edu.my/course/view.php?id=${c.courseId}`);
    (c.sessions || []).forEach((s) => {
      // STRICT REQUIREMENT: Only show attendance according to occurrence for each subject
      if (hasConfiguredOcc && !isRespectiveOccurrence(s.group, configuredOcc, s.description, s.activityName)) {
        return;
      }
      const isPast = isAttendanceSessionPastOrCurrent(s.date, s.time, s.status);
      const isUp = Boolean(s.status === "open" || s.isToday || s.status === "today" || !isPast);
      const isHist = Boolean(isPast && s.status !== "open" && s.status !== "today");

      allMatchingSessions.push({
        ...s,
        isPastOrCurrent: isPast,
        isUpcoming: isUp,
        isHistory: isHist,
        courseCode: c.courseCode,
        courseId: c.courseId,
        courseViewUrl: cViewUrl
      });
    });
  });

  // Calculate counts for filter pill badges
  const upcomingSessions = allMatchingSessions.filter((s) => s.isUpcoming);
  const historySessions = allMatchingSessions.filter((s) => s.isHistory);
  const totalAllCount = allMatchingSessions.length;

  if (countUpcomingEl) countUpcomingEl.textContent = upcomingSessions.length;
  if (countHistoryEl) countHistoryEl.textContent = historySessions.length;
  if (countAllEl) countAllEl.textContent = totalAllCount;

  // Sync active state on attendance pill buttons
  const currentFilter = state.attendanceFilter || "upcoming";
  document.querySelectorAll(".att-pill-btn").forEach((btn) => {
    if (btn.dataset.attFilter === currentFilter) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Filter sessions according to currentFilter
  let displaySessions = [];
  if (currentFilter === "upcoming") {
    // Upcoming: open check-ins first, scheduled today second, then earliest upcoming first
    displaySessions = [...upcomingSessions].sort((a, b) => {
      if (a.status === "open" && b.status !== "open") return -1;
      if (b.status === "open" && a.status !== "open") return 1;
      if (a.isToday && !b.isToday) return -1;
      if (b.isToday && !a.isToday) return 1;
      const tsA = a.timestamp || 0;
      const tsB = b.timestamp || 0;
      return tsA - tsB;
    });
  } else if (currentFilter === "history") {
    // History: most recent recorded first (descending)
    displaySessions = [...historySessions].sort((a, b) => {
      const tsA = a.timestamp || 0;
      const tsB = b.timestamp || 0;
      return tsB - tsA;
    });
  } else {
    // All: open/today on top, then chronologically descending
    displaySessions = [...allMatchingSessions].sort((a, b) => {
      if (a.status === "open" && b.status !== "open") return -1;
      if (b.status === "open" && a.status !== "open") return 1;
      if (a.isToday && !b.isToday) return -1;
      if (b.isToday && !a.isToday) return 1;
      const tsA = a.timestamp || 0;
      const tsB = b.timestamp || 0;
      return tsB - tsA;
    });
  }

  if (countBadge) {
    const filterLabel = currentFilter === "upcoming" ? "Upcoming" : currentFilter === "history" ? "Past" : "Total";
    countBadge.textContent = `${displaySessions.length} ${filterLabel} Session${displaySessions.length === 1 ? "" : "s"}`;
  }

  if (displaySessions.length === 0) {
    if (emptyState) {
      emptyState.classList.remove("hidden");
      const titleEl = emptyState.querySelector(".empty-title");
      const descEl = emptyState.querySelector(".empty-desc");
      if (titleEl) {
        titleEl.textContent = currentFilter === "upcoming"
          ? "No Upcoming Sessions"
          : currentFilter === "history"
          ? "No Attendance History"
          : "No Attendance Sessions";
      }
      if (descEl) {
        descEl.textContent = currentFilter === "upcoming"
          ? "No upcoming class or open check-in sessions found. Switch to History or All to view past attendance."
          : "No attendance sessions found matching your enrolled occurrences.";
      }
    }
    return;
  }

  if (emptyState) emptyState.classList.add("hidden");

  displaySessions.forEach((s) => {
    const card = document.createElement("div");
    const isSpecialCard = s.status === "open" ? "session-open" : s.status === "today" ? "session-today" : (s.isUpcoming && !s.isPastOrCurrent) ? "session-scheduled" : "";
    card.className = `attendance-session-card ${isSpecialCard}`.trim();

    let badgeClass = "badge-unrecorded";
    let statusText = s.statusLabel || "Unrecorded";

    if (s.status === "present") {
      badgeClass = "badge-present";
      statusText = "Present";
    } else if (s.status === "late") {
      badgeClass = "badge-late";
      statusText = "Late";
    } else if (s.status === "absent") {
      badgeClass = "badge-absent";
      statusText = "Absent";
    } else if (s.status === "excused") {
      badgeClass = "badge-excused";
      statusText = "Excused";
    } else if (s.status === "open") {
      badgeClass = "badge-open";
      statusText = "Open for Check-In";
    } else if (s.status === "today") {
      badgeClass = "badge-today";
      statusText = s.statusLabel || "Scheduled Today";
    } else if (s.isUpcoming && !s.isPastOrCurrent) {
      badgeClass = "badge-scheduled";
      statusText = "Scheduled";
    }

    card.innerHTML = `
      <div class="attendance-session-header">
        <div class="flex-align-center" style="gap: 5px;">
          <span class="announcement-course-pill">${s.courseCode}</span>
          <span class="session-group-pill">${s.group || "All students"}</span>
        </div>
        <span class="session-date-time">${s.date} ${s.time ? `• ${s.time}` : ""}</span>
      </div>
      <div class="attendance-session-desc">${s.description || "Class Session"}</div>
      <div class="attendance-session-footer">
        <span class="session-status-badge ${badgeClass}">${statusText}</span>
        <div class="flex-align-center" style="gap: 6px;">
          ${s.points ? `<span class="session-points-text">${s.points}</span>` : ""}
          ${s.status === "open" && s.submitUrl ? `
            <button class="btn-primary-action btn-xs session-submit-btn" data-url="${s.submitUrl}" data-sessid="${s.sessid || ""}" data-course="${s.courseCode || ""}" style="border: none; cursor: pointer; padding: 4px 10px; border-radius: 6px; font-weight: 600;">
              Submit ↗
            </button>
          ` : ""}
          <a href="${s.courseViewUrl}" data-url="${s.courseViewUrl}" class="btn-secondary-action btn-xs" style="text-decoration: none; padding: 3px 8px;" title="Open attendance page on SPeCTRUM">
            Open Page ↗
          </a>
        </div>
      </div>
    `;

    const sessionSubmitBtn = card.querySelector(".session-submit-btn");
    if (sessionSubmitBtn) {
      sessionSubmitBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleSubmitOpenAttendance({
          submitUrl: s.submitUrl,
          sessid: s.sessid,
          courseCode: s.courseCode,
          session: s
        });
      });
    }

    container.appendChild(card);
  });
}

/**
 * Save user occurrence for selected course
 */
async function handleSaveCourseOccurrence() {
  const occSelect = document.getElementById("occurrenceCourseSelect");
  const occInput = document.getElementById("occurrenceInput");
  const btn = document.getElementById("saveOccurrenceBtn");

  if (!occSelect || !occInput) return;

  const courseId = occSelect.value;
  const occurrence = occInput.value.trim();

  if (!courseId) {
    showToast("Please choose a course first", "error");
    return;
  }

  const course = state.courses.find((c) => String(c.id) === String(courseId));
  const courseCode = course?.code || courseId;

  btn.disabled = true;
  btn.textContent = "Saving...";

  state.courseOccurrences[courseId] = occurrence;
  if (courseCode) state.courseOccurrences[courseCode] = occurrence;

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      course_occurrences: state.courseOccurrences,
      courseOccurrences: state.courseOccurrences
    });
  }

  btn.disabled = false;
  btn.textContent = "Save Occurrence";

  showToast(`Saved ${courseCode} Occurrence: ${occurrence || "All"}!`, "success");
  updateOccurrenceInputField();
  renderActiveOccurrenceBadges();
  populateAttendanceCourseDropdowns();

  // Reload BOTH live deadlines (filtered by new occurrence) and live attendance
  await Promise.allSettled([
    loadLiveDeadlines(),
    loadLiveAttendanceData(true)
  ]);
}

/**
 * Handle instant scan for open attendance sessions
 */
async function handleScanAttendanceNow() {
  const btn = document.getElementById("scanAttendanceBtn");
  const loadingEl = document.getElementById("attendanceLoading");
  const emptyEl = document.getElementById("attendanceEmptyState");

  const origText = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span style="font-size: 11px;">Scanning...</span>`;
  }
  if (loadingEl) loadingEl.classList.remove("hidden");
  if (emptyEl) emptyEl.classList.add("hidden");

  try {
    // 1. Ensure sesskey is available
    if (!state.sesskey) {
      try {
        const sessCtx = await getSessionContext();
        state.sesskey = sessCtx.sesskey;
      } catch (e) {
        console.warn("[Spectra] Could not refresh sesskey for attendance scan:", e);
      }
    }

    // 2. Ensure enrolled courses are loaded
    if (!state.courses || state.courses.length === 0) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const stored = await chrome.storage.local.get(["cached_courses", "courses"]);
        if (stored?.cached_courses?.length > 0) {
          state.courses = stored.cached_courses;
        } else if (stored?.courses?.length > 0) {
          state.courses = stored.courses;
        }
      }
      if (!state.courses || state.courses.length === 0) {
        state.courses = await getLiveEnrolledCourses(state.sesskey);
      }
    }

    // 3. Scan live attendance data (no headless auto submit)
    const liveAttendance = await fetchLiveAllAttendance(
      state.courses,
      state.sesskey,
      state.courseOccurrences
    );

    state.attendance = liveAttendance;

    // Cache updated attendance data
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({
        cached_attendance: liveAttendance,
        last_attendance_sync: Date.now()
      });
    }

    populateAttendanceCourseDropdowns();
    renderActiveOccurrenceBadges();
    renderAttendanceSummaryMetrics();
    renderOpenAttendanceBanner();
    renderAttendanceRecords();

    const openCount = liveAttendance.openSessions?.length || 0;
    if (openCount > 0) {
      showToast(`Scan complete: ${openCount} open check-in session detected! Click Submit to check in.`, "info");
    } else {
      showToast("Scan finished: Attendance records up to date.", "info");
    }
  } catch (err) {
    console.error("[Spectra] Manual scan error:", err);
    showToast(`Scan error: ${err.message}`, "error");
  } finally {
    if (loadingEl) loadingEl.classList.add("hidden");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText || `<svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd"/></svg>`;
    }
  }
}

/**
 * Submit open attendance check-in:
 * Sets pending auto-fill flag and navigates to the attendance check-in page
 */
async function handleSubmitOpenAttendance(overrideParams = {}) {
  const pwdInput = document.getElementById("openAttendancePasswordInput");
  const openList = state.attendance?.openSessions || [];

  let submitUrl = overrideParams?.submitUrl;
  let sessid = overrideParams?.sessid;
  let courseCode = overrideParams?.courseCode;

  if (!submitUrl) {
    if (openList.length === 0) {
      showToast("No active open session detected.", "error");
      return;
    }
    const firstOpen = openList[0];
    const session = firstOpen.session;
    submitUrl = session?.submitUrl;
    sessid = session?.sessid;
    courseCode = firstOpen.courseCode;
  }

  if (!submitUrl) {
    showToast("This session has no check-in URL on SPeCTRUM.", "error");
    return;
  }

  const courseSavedPwd = (courseCode && state.coursePasswords?.[courseCode]) ? state.coursePasswords[courseCode] : "";
  const password = (pwdInput?.value?.trim()) || courseSavedPwd || "";

  const btnIcon = document.getElementById("submitBtnIcon");
  const btnLabel = document.getElementById("submitBtnLabel");
  const step2 = document.getElementById("stepperStep2");
  const step3 = document.getElementById("stepperStep3");

  if (btnIcon && btnLabel) {
    btnIcon.textContent = "⏳";
    btnLabel.textContent = "Auto-filling Present...";
  }

  if (step2 && step3) {
    step2.className = "stepper-step step-done";
    step2.querySelector(".stepper-icon").textContent = "✓";
    step2.querySelector(".stepper-icon").classList.remove("stepper-pulse");
    step3.className = "stepper-step step-current";
    const s3Icon = step3.querySelector(".stepper-icon");
    s3Icon.textContent = "🚀";
    s3Icon.classList.add("stepper-pulse");
  }

  // 1. Store pending autofill in storage for content script
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      spectra_pending_autofill: {
        sessid,
        courseCode,
        password,
        submitUrl,
        autoSubmit: true,
        timestamp: Date.now()
      }
    });
  }

  showToast(`Opening attendance for ${courseCode || "class"}... Auto-filling Present!`, "success");

  // 2. Open the attendance submit page in active browser tab
  if (typeof chrome !== "undefined" && chrome.tabs?.create) {
    chrome.tabs.create({ url: submitUrl, active: true });
  } else {
    window.open(submitUrl, "_blank");
  }
}

// ===================================================================
// TAB 4: LIVE CLASS PREP & MATERIAL BUNDLER
// ===================================================================
async function loadLiveEnrolledCourses() {
  const select = document.getElementById("courseSelect");
  const badge = document.getElementById("detectedCoursesBadge");

  try {
    const courses = await getLiveEnrolledCourses(state.sesskey);
    state.courses = courses;
    if (badge) badge.textContent = `${courses.length} Courses`;
    if (select) {
      select.innerHTML = "";
      if (courses.length === 0) {
        select.innerHTML = `<option value="">No enrolled courses detected on SPeCTRUM</option>`;
      } else {
        courses.forEach((c, idx) => {
          const opt = document.createElement("option");
          opt.value = c.id;
          opt.textContent = `${c.code} - ${c.name}`;
          if (idx === 0) {
            opt.selected = true;
            state.selectedCourse = c;
          }
          select.appendChild(opt);
        });
      }
    }

    if (typeof chrome !== "undefined" && chrome.storage?.local && courses.length > 0) {
      await chrome.storage.local.set({ cached_courses: courses, courses: courses });
    }

    populateAnnouncementSubjectDropdown();
    populateAttendanceCourseDropdowns();
  } catch (err) {
    console.error("[Spectra] Failed loading enrolled courses:", err);
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION" || err.message?.includes("SESSION_EXPIRED")) {
      updateAuthStatusBadge("invalid");
      updateSessionIndicator("disconnected", "Session Expired");
      updateInlineNoticeCards(false);
      renderUnauthenticatedStates(false);
    }
  }
}

function renderWeekPills() {
  const row = document.getElementById("weekPillsRow");
  if (!row) return;
  row.innerHTML = "";

  for (let w = 1; w <= 14; w++) {
    const pill = document.createElement("button");
    const isCurrent = w === state.currentAcademicWeek;
    const isSelected = w === state.selectedWeek;

    pill.className = `week-pill ${isSelected ? "active" : ""} ${isCurrent ? "is-current" : ""}`;
    pill.textContent = `W${w}`;
    pill.title = isCurrent ? `Week ${w} (Active Semester Week)` : `Week ${w}`;

    pill.addEventListener("click", async () => {
      state.selectedWeek = w;
      document.querySelectorAll(".week-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      document.getElementById("currentWeekTitle").textContent = `Week ${w} Materials`;
      document.getElementById("academicWeekTag").textContent = w === state.currentAcademicWeek ? "Active Week" : `Week ${w}`;
      updateFolderPreview();
      await loadLiveWeekMaterials();
    });

    row.appendChild(pill);
  }
}

function updateFolderPreview() {
  const preview = document.getElementById("packFolderPreview");
  if (!preview) return;
  const courseCode = state.selectedCourse ? state.selectedCourse.code : "Course";
  preview.textContent = `Downloads/Spectra/${courseCode}/Week_${state.selectedWeek}/`;
}

async function loadLiveWeekMaterials() {
  if (!state.selectedCourse) return;

  const loading = document.getElementById("materialsLoading");
  if (loading) loading.classList.remove("hidden");

  try {
    let selectedData = { slides: [], tutorials: [], labs: [] };

    if (!state.isDemoMode) {
      const weeksMap = await getLiveCourseMaterials(state.selectedCourse.id);
      selectedData = weeksMap[state.selectedWeek] || { slides: [], tutorials: [], labs: [] };
    } else {
      // Demo mock week data
      selectedData = getDemoWeekMaterials(state.selectedCourse.code, state.selectedWeek);
    }

    state.weekMaterials = {
      slides: selectedData.slides || [],
      tutorials: selectedData.tutorials || [],
      labs: selectedData.labs || []
    };

    renderMaterialGroup("slidesList", "slidesCountBadge", state.weekMaterials.slides);
    renderMaterialGroup("tutorialsList", "tutCountBadge", state.weekMaterials.tutorials);
    renderMaterialGroup("labsList", "labsCountBadge", state.weekMaterials.labs);

    const totalSlides = state.weekMaterials.slides.length;
    const totalTut = state.weekMaterials.tutorials.length;
    const totalLabs = state.weekMaterials.labs.length;
    const totalFiles = totalSlides + totalTut + totalLabs;

    document.getElementById("packSlidesCount").textContent = `📖 ${totalSlides} Slide${totalSlides === 1 ? "" : "s"}`;
    document.getElementById("packTutCount").textContent = `📝 ${totalTut} Tutorial${totalTut === 1 ? "" : "s"}`;
    document.getElementById("packLabCount").textContent = `💻 ${totalLabs} Lab${totalLabs === 1 ? "" : "s"}`;
    const totalFilesEl = document.getElementById("packTotalFiles");
    if (totalFilesEl) totalFilesEl.textContent = totalFiles;
  } catch (err) {
    console.error("[Spectra] Failed loading live course materials:", err);
    if (err instanceof InvalidSessionError || err.name === "INVALID_SESSION") {
      updateAuthStatusBadge("invalid");
      updateSessionIndicator("disconnected", "Session Expired");
      updateInlineNoticeCards(false);
      showToast("Session expired while loading materials. Please update MoodleSession cookie.", "error");
    }
  } finally {
    if (loading) loading.classList.add("hidden");
  }
}

function renderMaterialGroup(containerId, badgeId, items) {
  const container = document.getElementById(containerId);
  const badge = document.getElementById(badgeId);
  if (!container) return;
  container.innerHTML = "";
  if (badge) badge.textContent = items.length;

  if (items.length === 0) {
    container.innerHTML = `<div style="font-size:11px;color:var(--text-muted);padding:4px 0;">No items posted for this section on SPeCTRUM.</div>`;
    return;
  }

  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "material-item";

    const extClass = `ext-${item.ext || "default"}`;

    el.innerHTML = `
      <div class="file-left-group">
        <span class="ext-badge ${extClass}">${escapeHtml(item.ext || "file")}</span>
        <div class="file-name-size">
          <span class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          <span class="file-size">${escapeHtml(item.size || "SPeCTRUM File")}</span>
        </div>
      </div>
      <div class="file-actions">
        <button class="single-dl-btn" data-url="${escapeHtml(item.url)}" data-name="${escapeHtml(item.name)}" title="Download file">
          <svg viewBox="0 0 20 20" width="12" height="12" fill="currentColor">
            <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/>
          </svg>
        </button>
      </div>
    `;

    el.querySelector(".single-dl-btn").addEventListener("click", () => {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          action: "DOWNLOAD_WEEK_PACK",
          payload: {
            files: [{ name: item.name, url: item.url }],
            courseCode: state.selectedCourse ? state.selectedCourse.code : "Course",
            weekNumber: state.selectedWeek
          }
        }, () => {
          showToast(`Downloading: ${item.name}`, "info");
        });
      } else {
        showToast(`Download started: ${item.name}`, "info");
      }
    });

    container.appendChild(el);
  });
}

async function handleDownloadWeekPack() {
  const mats = state.weekMaterials;
  const allFiles = [
    ...(mats.slides || []),
    ...(mats.tutorials || []),
    ...(mats.labs || [])
  ];

  if (allFiles.length === 0) {
    showToast("No files uploaded for this week on SPeCTRUM.", "error");
    return;
  }

  const btn = document.getElementById("downloadWeekPackBtn");
  const progressBox = document.getElementById("downloadProgressContainer");
  const progressBar = document.getElementById("downloadProgressBar");
  const progressPercent = document.getElementById("downloadProgressPercent");
  const progressStatus = document.getElementById("downloadProgressStatus");

  btn.disabled = true;
  progressBox.classList.remove("hidden");
  progressBar.style.width = "25%";
  progressPercent.textContent = "25%";
  progressStatus.textContent = `Dispatching ${allFiles.length} downloads...`;

  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
      action: "DOWNLOAD_WEEK_PACK",
      payload: {
        files: allFiles,
        courseCode: state.selectedCourse ? state.selectedCourse.code : "Course",
        weekNumber: state.selectedWeek
      }
    }, (response) => {
      progressBar.style.width = "100%";
      progressPercent.textContent = "100%";
      progressStatus.textContent = "Saved to Downloads/Spectra!";

      btn.disabled = false;
      progressBox.classList.add("hidden");
      progressBar.style.width = "0%";
      if (response && response.success) {
        showToast(`Saved ${response.downloaded} files to Downloads/${response.folder}`, "success");
      } else {
        showToast("Download batch started.", "success");
      }
    });
  } else {
    progressBar.style.width = "100%";
    progressPercent.textContent = "100%";
    setTimeout(() => {
      btn.disabled = false;
      progressBox.classList.add("hidden");
      showToast(`Simulated download of ${allFiles.length} files.`, "success");
    }, 500);
  }
}

// ===================================================================
// TAB 3: SETTINGS LOGIC
// ===================================================================
async function handleTestTelegram() {
  const tokenInput = document.getElementById("telegramToken");
  const chatInput = document.getElementById("telegramChatId");
  if (!tokenInput || !chatInput) return;

  const rawBotToken = tokenInput.value;
  const rawChatId = chatInput.value;

  const botToken = sanitizeTelegramToken(rawBotToken);
  const chatId = sanitizeTelegramChatId(rawChatId);

  // Reflect sanitized values back to inputs
  if (botToken) tokenInput.value = botToken;
  if (chatId) chatInput.value = chatId;

  if (!botToken || !chatId) {
    showToast("Please enter both Bot Token and Chat ID", "error");
    return;
  }

  const btn = document.getElementById("testTelegramBtn");
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span>Sending test alert...</span>`;

  try {
    // 1. Direct dispatch from popup with native host_permissions
    let result = null;
    let directError = null;

    try {
      result = await sendTelegramTestMessage(botToken, chatId);
    } catch (err) {
      directError = err;
      console.warn("[Spectra Popup] Direct Telegram dispatch notice:", err);
    }

    // 2. Fallback to background service worker if direct call errored
    if (!result && directError) {
      try {
        result = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "SEND_TEST_TELEGRAM",
            payload: { botToken, chatId }
          }, (response) => {
            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message || directError.message));
            }
            if (response && response.success) {
              resolve(response.data || response);
            } else {
              reject(new Error(response?.error || response?.message || directError.message));
            }
          });
        });
      } catch (bgErr) {
        throw directError || bgErr;
      }
    }

    // Auto-save verified Telegram settings to chrome.storage.local
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({
        telegram_bot_token: botToken,
        telegram_chat_id: chatId
      });
    }

    showToast("Telegram message sent successfully! Check your phone.", "success");
  } catch (err) {
    console.error("[Spectra Popup] Telegram test failed:", err);
    showToast(`Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

async function handleSaveSettings() {
  const tokenInput = document.getElementById("telegramToken");
  const chatInput = document.getElementById("telegramChatId");
  const botToken = sanitizeTelegramToken(tokenInput ? tokenInput.value : "");
  const chatId = sanitizeTelegramChatId(chatInput ? chatInput.value : "");

  if (tokenInput && botToken) tokenInput.value = botToken;
  if (chatInput && chatId) chatInput.value = chatId;

  const icalInput = document.getElementById("calendarIcalUrl");
  const icalUrl = icalInput ? icalInput.value.trim() : "";
  const pollMins = parseInt(document.getElementById("pollIntervalSelect").value, 10);
  const notifyAttendanceOpen = document.getElementById("prefAttendanceOpen") ? document.getElementById("prefAttendanceOpen").checked : true;
  const notifyAnnounce = document.getElementById("prefAnnouncements").checked;
  const notifyDeadlines = document.getElementById("prefDeadlines").checked;

  state.notifyAttendanceOpen = notifyAttendanceOpen;

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      telegram_bot_token: botToken,
      telegram_chat_id: chatId,
      calendarIcalUrl: icalUrl,
      calendar_ical_url: icalUrl,
      poll_interval_mins: pollMins,
      notify_attendance_open: notifyAttendanceOpen,
      notify_announcements: notifyAnnounce,
      notify_urgent_deadlines: notifyDeadlines
    });

    chrome.runtime.sendMessage({
      action: "UPDATE_ALARMS",
      payload: { intervalMinutes: pollMins }
    });
  }

  showToast("Settings saved successfully!", "success");
}

async function handleAutoDiscoverIcal(silent = false) {
  const btn = document.getElementById("autoDiscoverIcalBtn");
  const origText = btn ? btn.innerHTML : "";
  if (btn && !silent) {
    btn.disabled = true;
    btn.textContent = "Discovering...";
  }

  try {
    const icalUrl = await autoDiscoverMoodleIcalUrl(state.sesskey);
    if (!icalUrl) {
      throw new Error("No iCal URL could be generated or detected.");
    }

    const icalInput = document.getElementById("calendarIcalUrl");
    if (icalInput) {
      icalInput.value = icalUrl;
    }

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({
        calendarIcalUrl: icalUrl,
        calendar_ical_url: icalUrl
      });
    }

    // Refresh deadlines tab with live iCal feed
    loadLiveDeadlines();

    if (!silent) {
      showToast("iCal Calendar URL automatically detected & saved! ✅", "success");
    }
    return icalUrl;
  } catch (err) {
    console.warn("[Spectra] Auto-discover iCal URL failed:", err);
    if (!silent) {
      showToast("Could not auto-detect iCal URL. Please log in to SPeCTRUM in your browser.", "error");
    }
    return null;
  } finally {
    if (btn && !silent) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}


// ===================================================================
// Demo Preview Mode Handler (for testing when off campus)
// ===================================================================
function enableDemoPreview() {
  state.isDemoMode = true;
  state.isAuthenticated = true;
  state.userName = "UM Student (Demo Mode)";

  updateSessionIndicator("connected", "Demo Preview");
  updateUserIdentityUI("Demo Student (UM)", "");
  setDisconnectedViewState(false);

  // Sample authentic UM courses
  state.courses = [
    { id: "demo_wix2002", code: "WIX2002", name: "Software Engineering Project Management", url: "https://spectrum.um.edu.my" },
    { id: "demo_wia1001", code: "WIA1001", name: "Information Systems & Digital Economy", url: "https://spectrum.um.edu.my" },
    { id: "demo_wix1002", code: "WIX1002", name: "Data Structures & Algorithms", url: "https://spectrum.um.edu.my" }
  ];

  // Populate course dropdown
  const select = document.getElementById("courseSelect");
  select.innerHTML = "";
  state.courses.forEach((c, idx) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.code} - ${c.name}`;
    if (idx === 0) {
      opt.selected = true;
      state.selectedCourse = c;
    }
    select.appendChild(opt);
  });

  // Sample deadlines
  state.deadlines = [
    {
      id: "demo_assign_1",
      title: "Sprint 1 Retrospective & Jira Board Export",
      courseCode: "WIX2002",
      courseName: "Software Engineering Project Management",
      dueTimestamp: Date.now() + 5.5 * 3600 * 1000,
      dueDate: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString(),
      url: "https://spectrum.um.edu.my/mod/assign/view.php?id=384102",
      type: "assign",
      urgency: "urgent",
      isCompleted: false,
      weight: "15%"
    },
    {
      id: "demo_assign_2",
      title: "Case Study 2: Cloud ERP Architecture Breakdown",
      courseCode: "WIA1001",
      courseName: "Information Systems & Digital Economy",
      dueTimestamp: Date.now() + 18 * 3600 * 1000,
      dueDate: new Date(Date.now() + 18 * 3600 * 1000).toISOString(),
      url: "https://spectrum.um.edu.my/mod/assign/view.php?id=384095",
      type: "assign",
      urgency: "urgent",
      isCompleted: false,
      weight: "10%"
    },
    {
      id: "demo_assign_3",
      title: "Lab Assignment 3: Red-Black Trees & Binary Heap",
      courseCode: "WIX1002",
      courseName: "Data Structures & Algorithms",
      dueTimestamp: Date.now() + 72 * 3600 * 1000,
      dueDate: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      url: "https://spectrum.um.edu.my/mod/assign/view.php?id=385200",
      type: "assign",
      urgency: "this_week",
      isCompleted: false,
      weight: "10%"
    }
  ];

  updateUrgentCountBadge();
  renderDeadlines();
  renderWeekPills();
  loadLiveWeekMaterials();

  // Demo announcements
  state.announcements = [
    {
      id: "demo_ann_1",
      courseCode: "WIX2002",
      subject: "Midterm Examination Date & Guidelines Announced",
      author: "Dr. Azman (Lecturer)",
      date: "Today, 10:30 AM",
      url: "https://spectrum.um.edu.my"
    },
    {
      id: "demo_ann_2",
      courseCode: "WIA1001",
      subject: "Tutorial Group Registration Deadline Tomorrow",
      author: "Prof. Sarah",
      date: "Yesterday, 3:15 PM",
      url: "https://spectrum.um.edu.my"
    },
    {
      id: "demo_ann_3",
      courseCode: "WIX1002",
      subject: "Lab 3 Red-Black Trees Starter Code Released",
      author: "En. Faris",
      date: "Oct 17, 2:00 PM",
      url: "https://spectrum.um.edu.my"
    }
  ];
  populateAnnouncementSubjectDropdown();
  renderAnnouncements();

  showToast("Demo preview active. All UI and downloader features unlocked!", "info");
}

function getDemoWeekMaterials(courseCode, weekNum) {
  return {
    slides: [
      { name: `Lecture 0${weekNum} - ${courseCode} Module Slides.pdf`, ext: "pdf", size: "3.4 MB", url: "https://spectrum.um.edu.my" },
      { name: "Course Outline & Assessment Rubrics.pdf", ext: "pdf", size: "840 KB", url: "https://spectrum.um.edu.my" }
    ],
    tutorials: [
      { name: `Tutorial 0${weekNum} - Worksheet & Exercises.docx`, ext: "docx", size: "420 KB", url: "https://spectrum.um.edu.my" }
    ],
    labs: [
      { name: `Lab 0${weekNum} - Starter Code Repository.zip`, ext: "zip", size: "2.1 MB", url: "https://spectrum.um.edu.my" }
    ]
  };
}

// ===================================================================
// Preferences & Storage Helpers
// ===================================================================
async function loadStoredPreferences() {
  let stored = {};
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    stored = await chrome.storage.local.get([
      "telegram_bot_token",
      "telegram_chat_id",
      "poll_interval_mins",
      "notify_announcements",
      "notify_urgent_deadlines",
      "notify_attendance_open",
      "completed_assignment_ids",
      "semester_start_date",
      "course_occurrences",
      "courseOccurrences",
      "studentOccurrence",
      "telegram_sent_announcement_ids",
      "telegram_sent_deadline_ids"
    ]);
  }

  if (Array.isArray(stored.telegram_sent_announcement_ids)) {
    state.telegramSentAnnouncementIds = new Set(stored.telegram_sent_announcement_ids.map(String));
  }
  if (Array.isArray(stored.telegram_sent_deadline_ids)) {
    state.telegramSentDeadlineIds = new Set(stored.telegram_sent_deadline_ids.map(String));
  }

  const tgNoticesCountEl = document.getElementById("tgSentNoticesCount");
  const tgDeadlinesCountEl = document.getElementById("tgSentDeadlinesCount");
  if (tgNoticesCountEl) tgNoticesCountEl.textContent = String(state.telegramSentAnnouncementIds.size);
  if (tgDeadlinesCountEl) tgDeadlinesCountEl.textContent = String(state.telegramSentDeadlineIds.size);

  if (stored.studentOccurrence) {
    state.studentOccurrence = stored.studentOccurrence;
  }
  if (stored.course_occurrences && typeof stored.course_occurrences === "object") {
    state.courseOccurrences = { ...state.courseOccurrences, ...stored.course_occurrences };
  }
  if (stored.courseOccurrences && typeof stored.courseOccurrences === "object") {
    state.courseOccurrences = { ...state.courseOccurrences, ...stored.courseOccurrences };
  }

  const notifyOpen = stored.notify_attendance_open !== false;
  state.notifyAttendanceOpen = notifyOpen;
  const attToggle = document.getElementById("telegramAttendanceOpenToggle");
  if (attToggle) attToggle.checked = notifyOpen;
  const prefOpen = document.getElementById("prefAttendanceOpen");
  if (prefOpen) prefOpen.checked = notifyOpen;
  const lbl = document.getElementById("telegramAttendanceOpenLabel");
  if (lbl) lbl.textContent = notifyOpen ? "Telegram Alert Active" : "Telegram Alert Paused";

  const tgTokenInput = document.getElementById("telegramToken");
  if (tgTokenInput && stored.telegram_bot_token) tgTokenInput.value = stored.telegram_bot_token;
  const tgChatInput = document.getElementById("telegramChatId");
  if (tgChatInput && stored.telegram_chat_id) tgChatInput.value = stored.telegram_chat_id;
  const icalInput = document.getElementById("calendarIcalUrl");
  if (icalInput && (stored.calendarIcalUrl || stored.calendar_ical_url)) {
    icalInput.value = stored.calendarIcalUrl || stored.calendar_ical_url;
  }

  const pollInterval = document.getElementById("pollIntervalSelect");
  if (pollInterval && stored.poll_interval_mins) pollInterval.value = String(stored.poll_interval_mins);
  const prefAnn = document.getElementById("prefAnnouncements");
  if (prefAnn && stored.notify_announcements !== undefined) prefAnn.checked = stored.notify_announcements;
  const prefDead = document.getElementById("prefDeadlines");
  if (prefDead && stored.notify_urgent_deadlines !== undefined) prefDead.checked = stored.notify_urgent_deadlines;

  if (Array.isArray(stored.completed_assignment_ids)) {
    state.completedIds = new Set(stored.completed_assignment_ids.map(String));
  }

  const academic = calculateAcademicWeek(stored.semester_start_date || "2026-10-05");
  state.currentAcademicWeek = academic.week;
  state.selectedWeek = academic.week;
  const weekBadge = document.getElementById("weekIndicatorBadge");
  if (weekBadge) weekBadge.textContent = `W${academic.week}`;
}

// ===================================================================
// Floating Feedback Toast
// ===================================================================
let toastTimeout = null;
function showToast(message, type = "success") {
  const toast = document.getElementById("feedbackToast");
  const icon = document.getElementById("toastIcon");
  const msg = document.getElementById("toastMsg");
  if (!toast) return;

  clearTimeout(toastTimeout);

  toast.className = `feedback-toast ${type === "error" ? "toast-error" : ""}`;
  icon.textContent = type === "error" ? "✕" : "✓";
  msg.textContent = message;

  toast.classList.remove("hidden");

  toastTimeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3200);
}

// ===================================================================
// Utilities
// ===================================================================
function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
