/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Live Calendar & Deadline Pipeline
 * Directly binds to SPeCTRUM's native AJAX calendar service and scans each enrolled course's
 * submission pages (/mod/assign/index.php and /course/view.php) from top to bottom,
 * filtering strictly by the student's respective occurrence.
 */

import {
  cleanMoodleTitle,
  extractCourseCode,
  calculateUrgency,
  parseCourseAssignmentsIndex,
  parseCourseQuizzesIndex,
  parseCourseViewSubmissions,
  parseEnrolledCourses,
  isRespectiveOccurrence,
  isAttendanceActivity,
  isOverdueMoreThan40Days,
  isOverdueMoreThan100Days,
  parseMoodleIcsCalendar,
  parseCourseContentsModules,
  parseAssignmentViewPage,
  pMap
} from "./parser.js";
import { InvalidSessionError, getSessionContext } from "./moodleApi.js";
import { fetchCourseContentsViaAjax } from "./courses.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

/**
 * Canonical task fingerprint function for deduplication across course HTML scrapes,
 * native Moodle AJAX, and RFC 5545 iCal feeds.
 */
export function getTaskFingerprint(courseCode, title) {
  const cleanCode = String(courseCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const baseTitle = String(title || "")
    .toLowerCase()
    .replace(/\s+is due(?:\s+to submit)?$/i, "");
  const strippedTitle = baseTitle
    .replace(/\b(?:tutorial|tut|lab|assignment|submission|link|dropbox)\b/gi, "")
    .replace(/[^a-z0-9]/g, "");
  const cleanTitle = strippedTitle || baseTitle.replace(/[^a-z0-9]/g, "");
  return `${cleanCode}_${cleanTitle}`;
}

/**
 * Merges a course-level scraped item and an iCal feed item:
 * Preserves the real cmid, direct URL, and verified submission status from the course scrape,
 * while keeping the high-precision timestamp from the iCal event.
 */
export function mergeDeadlineItems(existing, incoming, completedSet = new Set()) {
  const isExistingIcal = existing?.source === "ical" || (existing?.url && existing.url.includes("calendar/view.php"));
  const isIncomingIcal = incoming?.source === "ical" || (incoming?.url && incoming.url.includes("calendar/view.php"));

  let courseItem = null;
  let icalItem = null;

  if (isExistingIcal && !isIncomingIcal) {
    icalItem = existing;
    courseItem = incoming;
  } else if (!isExistingIcal && isIncomingIcal) {
    courseItem = existing;
    icalItem = incoming;
  } else {
    // Both are same type: prefer item with cmid or direct mod url as courseItem
    const hasDirectA = existing?.url && /\/mod\/[a-z]+\/view\.php\?id=\d+/i.test(existing.url);
    const hasDirectB = incoming?.url && /\/mod\/[a-z]+\/view\.php\?id=\d+/i.test(incoming.url);
    if (hasDirectB && !hasDirectA) {
      courseItem = incoming;
      icalItem = existing;
    } else {
      courseItem = existing;
      icalItem = incoming;
    }
  }

  // Preserve real cmid and direct URL from course scrape
  const realCmid = courseItem.cmid || icalItem.cmid || "";
  const directUrl = (courseItem.url && /\/mod\/[a-z]+\/view\.php/i.test(courseItem.url))
    ? courseItem.url
    : (icalItem.url && /\/mod\/[a-z]+\/view\.php/i.test(icalItem.url) ? icalItem.url : (courseItem.url || icalItem.url));

  // High-precision timestamp from iCal event (or fallback to course item)
  const dueTimestamp = icalItem.dueTimestamp || courseItem.dueTimestamp || null;
  const dueDate = (icalItem.dueTimestamp && icalItem.dueDate) ? icalItem.dueDate : (courseItem.dueDate || icalItem.dueDate || "");
  const formattedTime = (icalItem.dueTimestamp && icalItem.formattedTime) ? icalItem.formattedTime : (courseItem.formattedTime || icalItem.formattedTime || "");

  // Submission status from course scrape
  const isSubmittedOnSpectrum = Boolean(courseItem.isSubmittedOnSpectrum || icalItem.isSubmittedOnSpectrum);
  const statusText = courseItem.submissionStatus && courseItem.submissionStatus !== "No submission recorded"
    ? courseItem.submissionStatus
    : (icalItem.submissionStatus || courseItem.submissionStatus || "No submission recorded");

  // Determine id: prefer real cmid, then courseItem id, then icalItem id
  const id = realCmid || courseItem.id || icalItem.id;

  // Local completion check
  const isCompleted = isSubmittedOnSpectrum ||
    Boolean(courseItem.isCompleted) ||
    Boolean(icalItem.isCompleted) ||
    completedSet.has(String(id)) ||
    (realCmid && completedSet.has(String(realCmid))) ||
    completedSet.has(String(courseItem.id)) ||
    completedSet.has(String(icalItem.id));

  return {
    ...icalItem,
    ...courseItem,
    id: String(id),
    cmid: realCmid ? String(realCmid) : "",
    title: courseItem.title || icalItem.title,
    courseCode: courseItem.courseCode || icalItem.courseCode,
    courseName: courseItem.courseName || icalItem.courseName || courseItem.courseCode || icalItem.courseCode,
    dueTimestamp,
    dueDate,
    formattedTime,
    url: directUrl,
    type: courseItem.type || icalItem.type || "assign",
    urgency: dueTimestamp ? calculateUrgency(dueTimestamp) : (courseItem.urgency || icalItem.urgency || "upcoming"),
    isSubmittedOnSpectrum,
    isCompleted,
    submissionStatus: isSubmittedOnSpectrum && statusText === "No submission recorded" ? "Submitted" : statusText,
    weight: courseItem.weight || icalItem.weight || "",
    matchesOccurrence: true,
    source: courseItem.source || icalItem.source || "merged"
  };
}

/**
 * Deduplicate deadlines list using both seenIds (id and cmid) and seenFingerprints.
 * Merges course-level scraped entries with matching iCal entries.
 */
export function deduplicateDeadlinesList(items = [], completedSet = new Set()) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const completed = completedSet instanceof Set
    ? completedSet
    : new Set(Array.isArray(completedSet) ? completedSet.map(String) : []);

  const seenIds = new Map();
  const seenFingerprints = new Map();
  const deduped = [];

  for (const item of items) {
    if (!item) continue;
    const fp = getTaskFingerprint(item.courseCode, item.title || item.name || "");
    const rawId = item.id ? String(item.id) : "";
    const rawCmid = item.cmid ? String(item.cmid) : "";

    let matchIdx = -1;
    if (fp && seenFingerprints.has(fp)) {
      matchIdx = seenFingerprints.get(fp);
    } else if (rawCmid && seenIds.has(`cmid_${rawCmid}`)) {
      matchIdx = seenIds.get(`cmid_${rawCmid}`);
    } else if (rawId && seenIds.has(`id_${rawId}`)) {
      matchIdx = seenIds.get(`id_${rawId}`);
    }

    if (matchIdx >= 0) {
      const existing = deduped[matchIdx];
      const merged = mergeDeadlineItems(existing, item, completed);
      deduped[matchIdx] = merged;
      if (merged.id) seenIds.set(`id_${merged.id}`, matchIdx);
      if (merged.cmid) seenIds.set(`cmid_${merged.cmid}`, matchIdx);
      if (fp) seenFingerprints.set(fp, matchIdx);
    } else {
      const idx = deduped.length;
      deduped.push(item);
      if (fp) seenFingerprints.set(fp, idx);
      if (rawId) seenIds.set(`id_${rawId}`, idx);
      if (rawCmid) seenIds.set(`cmid_${rawCmid}`, idx);
    }
  }

  return deduped;
}

/**
 * Generate normalized activity key for deduplicating activities across
 * Calendar AJAX, /mod/assign/index.php, and /course/view.php
 */
function getActivityKey(item) {
  if (item.url) {
    const modMatch = item.url.match(/mod\/([a-z0-9_]+)\/view\.php\?id=(\d+)/i);
    if (modMatch) return `${modMatch[1]}_${modMatch[2]}`;
  }
  if (item.cmid) return `${item.type || "assign"}_${item.cmid}`;
  if (item.id && !String(item.id).startsWith("event-")) return `${item.type || "assign"}_${item.id}`;
  return getTaskFingerprint(item.courseCode, item.title || item.name || "");
}

/**
 * Fetch and parse deadlines directly from Moodle's iCalendar (.ics) export URL.
 * Works without active cookie session expiration.
 */
export async function fetchIcsDeadlines(calendarIcalUrl, occurrencesMap = {}, defaultOccurrence = "") {
  if (!calendarIcalUrl) return [];
  try {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const tid = ctrl ? setTimeout(() => ctrl.abort(), 7000) : null;
    let res;
    try {
      res = await fetch(calendarIcalUrl, { signal: ctrl?.signal });
    } finally {
      if (tid) clearTimeout(tid);
    }
    if (!res || !res.ok) return [];
    const icsText = await res.text();
    return parseMoodleIcsCalendar(icsText, occurrencesMap, defaultOccurrence);
  } catch (err) {
    console.warn("[Spectra] Error fetching iCal feed:", err);
    return [];
  }
}

/**
 * Fetch live submission deadlines directly from Moodle's native AJAX calendar service,
 * iCalendar export feed, and course contents (pure JSON via core_course_get_contents),
 * with fallback to course assignment index and top-to-bottom HTML scanning.
 *
 * @param {string} [sesskey] - User session key
 * @param {Array} [courses] - Enrolled course objects [{ id, code, name }]
 * @param {Object} [occurrencesMap] - Map of courseId/courseCode -> student occurrence string (e.g. "Occ 1")
 * @param {string} [defaultOccurrence] - Fallback student occurrence
 * @param {string} [calendarIcalUrl] - Optional persistent Moodle iCal URL
 * @returns {Promise<Array>} Array of unified deadlines
 */
export async function fetchLiveDeadlines(sesskey, courses = [], occurrencesMap = {}, defaultOccurrence = "", calendarIcalUrl = "") {
  if (!sesskey) {
    try {
      const ctx = await getSessionContext();
      sesskey = ctx.sesskey;
    } catch (e) {
      // Session context retrieval failed, will proceed if courses are already available or throw if unauthenticated
    }
  }

  // Load courses, occurrences, and optional iCal URL from storage if not provided
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get([
        "courses",
        "cached_courses",
        "course_occurrences",
        "courseOccurrences",
        "studentOccurrence",
        "calendarIcalUrl",
        "calendar_ical_url"
      ]);
      if ((!courses || courses.length === 0) && Array.isArray(stored.courses) && stored.courses.length > 0) {
        courses = stored.courses;
      } else if ((!courses || courses.length === 0) && Array.isArray(stored.cached_courses) && stored.cached_courses.length > 0) {
        courses = stored.cached_courses;
      }
      const localOccMap = stored.course_occurrences || stored.courseOccurrences || {};
      if (Object.keys(occurrencesMap).length === 0 && Object.keys(localOccMap).length > 0) {
        occurrencesMap = localOccMap;
      }
      if (!defaultOccurrence && stored.studentOccurrence) {
        defaultOccurrence = stored.studentOccurrence;
      }
      if (!calendarIcalUrl) {
        calendarIcalUrl = stored.calendarIcalUrl || stored.calendar_ical_url || "";
      }
    } catch (e) { }
  }

  // If courses list is still empty, auto-discover enrolled courses from /my/
  if (!courses || courses.length === 0) {
    try {
      const myRes = await fetch(`${SPECTRUM_BASE_URL}/my/`, { credentials: "include" });
      if (myRes.ok) {
        const myHtml = await myRes.text();
        courses = parseEnrolledCourses(myHtml);
      }
    } catch (e) {
      console.warn("[Spectra] Could not auto-fetch enrolled courses from /my/:", e);
    }
  }

  // Retrieve locally marked completed IDs
  let completedSet = new Set();
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(["completed_assignment_ids"]);
      completedSet = new Set(stored.completed_assignment_ids || []);
    } catch (e) { }
  }

  const deadlinesMap = new Map();
  const fingerprintMap = new Map();

  function upsertDeadlineItem(incoming, sourceLevel = "general") {
    if (!incoming) return;
    const key = getActivityKey(incoming);
    const fp = getTaskFingerprint(incoming.courseCode, incoming.title || incoming.name || "");

    let existingKey = deadlinesMap.has(key) ? key : null;
    if (!existingKey && fp && fingerprintMap.has(fp)) {
      existingKey = fingerprintMap.get(fp);
    }

    if (existingKey) {
      const existing = deadlinesMap.get(existingKey);
      const merged = mergeDeadlineItems(existing, incoming, completedSet);

      if (sourceLevel === "authoritative") {
        merged.isSubmittedOnSpectrum = incoming.isSubmittedOnSpectrum;
        merged.isCompleted = incoming.isSubmittedOnSpectrum || merged.isCompleted;
        merged.submissionStatus = incoming.submissionStatus || merged.submissionStatus;
      }

      const newKey = getActivityKey(merged);
      if (newKey !== existingKey) {
        deadlinesMap.delete(existingKey);
      }
      deadlinesMap.set(newKey, merged);
      if (fp) fingerprintMap.set(fp, newKey);
    } else {
      if (completedSet.has(String(incoming.id)) || (incoming.cmid && completedSet.has(String(incoming.cmid)))) {
        incoming.isCompleted = true;
      }
      deadlinesMap.set(key, incoming);
      if (fp) fingerprintMap.set(fp, key);
    }
  }

  // -------------------------------------------------------------
  // 0. Fetch Moodle iCalendar (.ics) Feed If Configured (Permanent, No Expiry)
  // -------------------------------------------------------------
  if (calendarIcalUrl) {
    try {
      const icsItems = await fetchIcsDeadlines(calendarIcalUrl, occurrencesMap, defaultOccurrence);
      icsItems.forEach((item) => upsertDeadlineItem(item, "ical"));
    } catch (icsErr) {
      console.warn("[Spectra] iCal feed load notice:", icsErr);
    }
  }

  // -------------------------------------------------------------
  // 1. Fetch Course Submissions Directly (Moodle AJAX JSON + /mod/assign/index.php)
  //    Authoritative source of truth: 100% group-restricted by Moodle, exact submission statuses.
  // -------------------------------------------------------------
  if (Array.isArray(courses) && courses.length > 0) {
    await pMap(courses, async (course) => {
      const courseId = course.id;
      const courseCode = course.code || course.shortname || extractCourseCode(course.name) || "Course";
      const courseName = course.name || courseCode;
      const studentOcc = occurrencesMap[courseId] || occurrencesMap[courseCode] || defaultOccurrence || "";

      // A. Try native Moodle AJAX core_course_get_contents first (Fastest, pure JSON, zero HTML overhead)
      let ajaxSuccess = false;
      if (sesskey) {
        try {
          const sections = await fetchCourseContentsViaAjax(courseId, sesskey);
          if (Array.isArray(sections) && sections.length > 0) {
            const { assignments } = parseCourseContentsModules(sections, courseCode, courseName, studentOcc);
            assignments.forEach((item) => upsertDeadlineItem(item, "ajax"));
            ajaxSuccess = true;
          }
        } catch (ajaxErr) {
          if (ajaxErr?.name !== "AbortError" && !ajaxErr?.message?.includes("aborted")) {
            console.debug(`[Spectra] core_course_get_contents note for ${courseCode}:`, ajaxErr?.message || ajaxErr);
          }
        }
      }

      // B. Check /mod/assign/index.php?id={courseId} (Assignments overview page for status enrichment)
      try {
        const assignIndexUrl = `${SPECTRUM_BASE_URL}/mod/assign/index.php?id=${encodeURIComponent(courseId)}`;
        const ctrl1 = typeof AbortController !== "undefined" ? new AbortController() : null;
        const tid1 = ctrl1 ? setTimeout(() => ctrl1.abort(), 20000) : null;
        let res;
        try {
          res = await fetch(assignIndexUrl, { credentials: "include", signal: ctrl1?.signal });
        } finally {
          if (tid1) clearTimeout(tid1);
        }
        if (res && res.ok) {
          const html = await res.text();
          const items = parseCourseAssignmentsIndex(html, courseCode, courseName, studentOcc);
          items.forEach((item) => upsertDeadlineItem(item, "authoritative"));
        }
      } catch (err) {
        if (err?.name !== "AbortError" && !err?.message?.includes("aborted")) {
          console.debug(`[Spectra] Assign index note for ${courseCode}:`, err?.message || err);
        }
      }

      // B2. Check /mod/quiz/index.php?id={courseId} (Quizzes overview page for closed dates)
      try {
        const quizIndexUrl = `${SPECTRUM_BASE_URL}/mod/quiz/index.php?id=${encodeURIComponent(courseId)}`;
        const ctrlQ = typeof AbortController !== "undefined" ? new AbortController() : null;
        const tidQ = ctrlQ ? setTimeout(() => ctrlQ.abort(), 20000) : null;
        let resQ;
        try {
          resQ = await fetch(quizIndexUrl, { credentials: "include", signal: ctrlQ?.signal });
        } finally {
          if (tidQ) clearTimeout(tidQ);
        }
        if (resQ && resQ.ok) {
          const html = await resQ.text();
          const items = parseCourseQuizzesIndex(html, courseCode, courseName, studentOcc);
          items.forEach((item) => upsertDeadlineItem(item, "authoritative"));
        }
      } catch (err) {
        if (err?.name !== "AbortError" && !err?.message?.includes("aborted")) {
          console.debug(`[Spectra] Quiz index note for ${courseCode}:`, err?.message || err);
        }
      }

      // C. Check /course/view.php?id={courseId} (Scanned top to bottom as fallback if AJAX didn't capture or items are missing due dates)
      const hasMissingDueForCourse = Array.from(deadlinesMap.values()).some(
        (it) => (it.courseCode === courseCode || it.courseName === courseName) && !it.dueTimestamp
      );
      if (!ajaxSuccess || hasMissingDueForCourse) {
        try {
          const courseViewUrl = `${SPECTRUM_BASE_URL}/course/view.php?id=${encodeURIComponent(courseId)}`;
          const ctrl2 = typeof AbortController !== "undefined" ? new AbortController() : null;
          const tid2 = ctrl2 ? setTimeout(() => ctrl2.abort(), 20000) : null;
          let res;
          try {
            res = await fetch(courseViewUrl, { credentials: "include", signal: ctrl2?.signal });
          } finally {
            if (tid2) clearTimeout(tid2);
          }
          if (res && res.ok) {
            const html = await res.text();
            const items = parseCourseViewSubmissions(html, courseCode, courseName, studentOcc);
            items.forEach((item) => upsertDeadlineItem(item, "courseview"));
          }
        } catch (err) {
          if (err?.name !== "AbortError" && !err?.message?.includes("aborted")) {
            console.debug(`[Spectra] Course view submissions note for ${courseCode}:`, err?.message || err);
          }
        }
      }
    }, 2);
  }

  // -------------------------------------------------------------
  // 2B. Direct view inspection for any activities still lacking due dates
  // -------------------------------------------------------------
  const missingDueItems = Array.from(deadlinesMap.values()).filter(
    (item) => !item.dueTimestamp && item.url && (
      item.url.includes("mod/assign/view.php") ||
      item.url.includes("mod/quiz/view.php") ||
      item.url.includes("mod/turnitintooltwo/view.php") ||
      item.url.includes("mod/workshop/view.php")
    )
  );
  if (missingDueItems.length > 0) {
    await pMap(missingDueItems.slice(0, 40), async (item) => {
      try {
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const tid = ctrl ? setTimeout(() => ctrl.abort(), 12000) : null;
        let res;
        try {
          res = await fetch(item.url, { credentials: "include", signal: ctrl?.signal });
        } finally {
          if (tid) clearTimeout(tid);
        }
        if (res && res.ok) {
          const pageHtml = await res.text();
          const details = parseAssignmentViewPage(pageHtml);
          if (details) {
            if (details.dueTimestamp) {
              item.dueTimestamp = details.dueTimestamp;
              item.dueDate = new Date(details.dueTimestamp).toISOString();
              item.formattedTime = details.dueDateText;
              item.urgency = calculateUrgency(details.dueTimestamp);
              if (details.dateLabel) item.dateLabel = details.dateLabel;
            }
            if (details.isSubmitted) {
              item.isSubmittedOnSpectrum = true;
              item.isCompleted = true;
              item.submissionStatus = details.submissionStatus || "Submitted";
            }
          }
        }
      } catch (_) { }
    }, 4);
  }

  // -------------------------------------------------------------
  // 3. Finalize Urgency, Local Completion, Attendance Exclusion, and Sort
  // -------------------------------------------------------------
  const allDeadlines = Array.from(deadlinesMap.values())
    .filter((item) => !isAttendanceActivity(item))
    .filter((item) => !isOverdueMoreThan40Days(item.dueTimestamp))
    .map((item) => {
      const isCompleted = item.isSubmittedOnSpectrum || completedSet.has(String(item.id)) || (item.cmid && completedSet.has(String(item.cmid)));
      const urgency = item.dueTimestamp ? calculateUrgency(item.dueTimestamp) : "upcoming";
      return {
        ...item,
        isCompleted,
        urgency
      };
    });

  const deduplicated = deduplicateDeadlinesList(allDeadlines, completedSet);

  // Sort: Incomplete first, then by earliest due date. Items with no due date go to the bottom of incomplete.
  deduplicated.sort((a, b) => {
    if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
    if (a.dueTimestamp && b.dueTimestamp) return a.dueTimestamp - b.dueTimestamp;
    if (a.dueTimestamp && !b.dueTimestamp) return -1;
    if (!a.dueTimestamp && b.dueTimestamp) return 1;
    return (a.title || "").localeCompare(b.title || "");
  });

  return deduplicated;
}

/**
 * Normalizes and filters cached or scraped deadlines for UI pre-hydration and rendering.
 * Strictly prioritizes processed cached_deadlines (events) over raw calendar events.
 * Enforces student occurrence filtering, attendance activity exclusion, 100-day overdue exclusion,
 * and preserves verified submission and completion statuses across popup re-opens.
 *
 * @param {Array} [events] - Cached processed deadlines or table scraper items
 * @param {Array} [rawCalendarEvents] - Fallback raw Moodle calendar action events
 * @param {Object} [options] - Options containing courseOccurrences, studentOccurrence, and completedIds
 * @returns {Array} Clean, filtered, sorted deadline objects
 */
export function normalizeHydratedDeadlines(events = [], rawCalendarEvents = [], options = {}) {
  const {
    courseOccurrences = {},
    studentOccurrence = "",
    completedIds = new Set()
  } = options;

  const completedSet = completedIds instanceof Set
    ? completedIds
    : new Set(Array.isArray(completedIds) ? completedIds.map(String) : []);

  // Precedence: cached_deadlines (events) strictly takes priority over rawCalendarEvents
  let candidateList = [];
  let isRawCalendar = false;

  if (Array.isArray(events) && events.length > 0) {
    candidateList = events;
    isRawCalendar = false;
  } else if (Array.isArray(events) && events.length === 0 && (!rawCalendarEvents || rawCalendarEvents.length === 0 || Array.isArray(rawCalendarEvents))) {
    // If events was explicitly provided as an empty array [] (from cached_deadlines),
    // we should trust it: the student has 0 upcoming deadlines or has finished them.
    // Never fall back to rawCalendarEvents to resurrect items from other occurrences.
    return [];
  } else if (Array.isArray(rawCalendarEvents) && rawCalendarEvents.length > 0) {
    candidateList = rawCalendarEvents;
    isRawCalendar = true;
  } else {
    return [];
  }

  const normalized = [];

  for (let idx = 0; idx < candidateList.length; idx++) {
    const item = candidateList[idx];
    if (!item) continue;

    if (isRawCalendar) {
      // 1. Strictly exclude attendance activities
      if (
        isAttendanceActivity(item) ||
        (item.modulename || "").toLowerCase() === "attendance" ||
        (item.eventtype || "").toLowerCase() === "attendance"
      ) {
        continue;
      }

      const timestamp = (item.timesort || item.timestart) * 1000;
      if (isOverdueMoreThan40Days(timestamp)) {
        continue;
      }

      const courseCode = extractCourseCode(item.course?.shortname || item.course?.fullname || "");
      const courseId = item.course?.id ? String(item.course.id) : "";
      const studentOcc = (courseOccurrences && (courseOccurrences[courseId] || courseOccurrences[courseCode])) || studentOccurrence || "";
      const title = cleanMoodleTitle(item.name || item.title || "");

      // Strict occurrence filter: if event belongs to another occurrence, exclude it!
      if (!isRespectiveOccurrence("", studentOcc, title)) {
        continue;
      }

      const eventUrl = item.action?.url || item.url || (item.instance ? `${SPECTRUM_BASE_URL}/mod/${item.modulename || "assign"}/view.php?id=${item.instance}` : `${SPECTRUM_BASE_URL}/calendar/view.php?view=event&id=${item.id}`);
      const eventId = String(item.id);
      const cmid = item.instance ? String(item.instance) : "";
      const isActionDone = item.action ? !item.action.actionable : false;
      const isCompleted = isActionDone || completedSet.has(eventId) || (cmid && completedSet.has(cmid));

      normalized.push({
        id: eventId,
        cmid: cmid || eventId,
        title,
        courseCode: courseCode || (item.course?.shortname || "N/A"),
        courseName: item.course?.fullname || courseCode,
        dueDate: new Date(timestamp).toISOString(),
        dueTimestamp: timestamp,
        formattedTime: item.formattedtime || new Date(timestamp).toLocaleString("en-MY", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }),
        url: eventUrl,
        type: item.modulename || "assign",
        urgency: calculateUrgency(timestamp),
        isSubmittedOnSpectrum: isActionDone,
        isCompleted,
        submissionStatus: isActionDone ? "Submitted" : "No submission",
        weight: "",
        matchesOccurrence: true
      });
    } else {
      // Branch 2: Item from cached_deadlines or legacy table scraper
      if (item && (item.title !== undefined || item.name !== undefined)) {
        // Standard live deadline object
        if (isAttendanceActivity(item)) continue;
        const title = cleanMoodleTitle(item.title || item.name || "");
        if (!title) continue;

        // Strictly eliminate synthetic ghost items created by old fallback bugs
        const isSyntheticGhost = (
          (item.id && String(item.id).startsWith("scraped-") && (!item.url || item.url.includes("/my/"))) ||
          (item.courseCode === "UM" && (!item.url || !item.url.includes("view.php?id=")))
        );
        if (isSyntheticGhost) {
          continue;
        }

        const timestamp = item.dueTimestamp || (item.dueDate ? Date.parse(item.dueDate) : null);
        if (timestamp && isOverdueMoreThan40Days(timestamp)) continue;

        const courseCode = item.courseCode || extractCourseCode(item.courseName || item.title || item.name || "");
        const courseId = item.courseId ? String(item.courseId) : "";
        const studentOcc = (courseOccurrences && (courseOccurrences[courseId] || courseOccurrences[courseCode])) || studentOccurrence || "";

        // Strict occurrence filter
        if (!isRespectiveOccurrence("", studentOcc, title)) {
          continue;
        }

        const eventId = String(item.id || (item.cmid ? `deadline-${item.cmid}` : `deadline-${idx}`));
        const cmid = item.cmid ? String(item.cmid) : "";

        // Preserve verified submission statuses
        const statusText = item.submissionStatus || "";
        const isStatusSubmitted = /\b(?:submitted|submission|graded|grading|selesai|dihantar|dinilai|diserahkan)\b/i.test(statusText) && !/\b(?:no submission|not submitted|belum|tiada|tidak|draft|draf)\b/i.test(statusText);
        const isSubmittedOnSpectrum = Boolean(item.isSubmittedOnSpectrum) || isStatusSubmitted;
        const isCompleted = isSubmittedOnSpectrum || Boolean(item.isCompleted) || completedSet.has(eventId) || (cmid && completedSet.has(cmid));

        normalized.push({
          ...item,
          id: eventId,
          cmid: cmid || (item.source === "ical" || (item.url && item.url.includes("calendar/view.php")) ? "" : eventId),
          title,
          courseCode: courseCode || "N/A",
          courseName: item.courseName || item.courseCode || "N/A",
          dueDate: timestamp ? (item.dueDate || new Date(timestamp).toISOString()) : "",
          dueTimestamp: timestamp || null,
          formattedTime: item.formattedTime || (timestamp ? new Date(timestamp).toLocaleString("en-MY", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          }) : "No due date"),
          url: item.url || (item.courseId ? `${SPECTRUM_BASE_URL}/course/view.php?id=${item.courseId}` : `${SPECTRUM_BASE_URL}/my/`),
          type: item.type || "assign",
          urgency: timestamp ? calculateUrgency(timestamp) : "upcoming",
          isSubmittedOnSpectrum,
          isCompleted,
          submissionStatus: isSubmittedOnSpectrum ? (statusText || "Submitted") : (statusText || "No submission"),
          weight: item.weight || "",
          matchesOccurrence: true
        });
      } else if (item && item["Assignment / Task"] && item["Due Date"]) {
        // Valid legacy table scraper item with explicit title and due date
        const title = cleanMoodleTitle(item["Assignment / Task"]);
        if (!title || title.toLowerCase() === "assignment") continue;

        const dueTs = Date.parse(item["Due Date"]);
        if (!dueTs || isNaN(dueTs) || isOverdueMoreThan40Days(dueTs)) continue;

        const code = extractCourseCode(item["Course Code"] || "") || item["Course Code"] || "N/A";
        const studentOcc = (courseOccurrences && courseOccurrences[code]) || studentOccurrence || "";

        if (!isRespectiveOccurrence("", studentOcc, title)) {
          continue;
        }

        const subText = item["Submitted?"] || "";
        const isSubmitted = /\b(?:submitted|graded|dihantar|selesai|dinilai|diserahkan)\b/i.test(subText) && !/\b(?:pending|belum|tiada|tidak)\b/i.test(subText);
        const id = `scraped-${idx}-${title}`;
        const isCompleted = isSubmitted || completedSet.has(id);

        normalized.push({
          id,
          cmid: id,
          title,
          courseCode: code,
          courseName: item["Course Code"] || code,
          dueDate: new Date(dueTs).toISOString(),
          dueTimestamp: dueTs,
          formattedTime: item["Due Date"] || new Date(dueTs).toLocaleString(),
          url: item["Direct Link"] || `${SPECTRUM_BASE_URL}/my/`,
          type: "assign",
          urgency: calculateUrgency(dueTs),
          isSubmittedOnSpectrum: isSubmitted,
          isCompleted,
          submissionStatus: isSubmitted ? "Submitted" : "No submission",
          weight: "",
          matchesOccurrence: true
        });
      }
    }
  }

  const deduplicated = deduplicateDeadlinesList(normalized, completedSet);

  // Sort deadlines: pending first, then by earliest due date
  deduplicated.sort((a, b) => {
    if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
    if (a.dueTimestamp && b.dueTimestamp) return a.dueTimestamp - b.dueTimestamp;
    if (a.dueTimestamp && !b.dueTimestamp) return -1;
    if (!a.dueTimestamp && b.dueTimestamp) return 1;
    return (a.title || "").localeCompare(b.title || "");
  });

  return deduplicated;
}

