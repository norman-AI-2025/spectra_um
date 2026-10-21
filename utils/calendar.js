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
  parseCourseViewSubmissions,
  parseEnrolledCourses,
  isRespectiveOccurrence,
  isAttendanceActivity,
  isOverdueMoreThan100Days,
  parseMoodleIcsCalendar,
  parseCourseContentsModules,
  pMap
} from "./parser.js";
import { InvalidSessionError, getSessionContext } from "./moodleApi.js";
import { fetchCourseContentsViaAjax } from "./courses.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

/**
 * Generate normalized activity key for deduplicating activities across
 * Calendar AJAX, /mod/assign/index.php, and /course/view.php
 */
function getActivityKey(item) {
  if (item.url) {
    const m = item.url.match(/id=(\d+)/);
    const mod = item.url.match(/mod\/([a-z0-9_]+)\//);
    const modName = mod ? mod[1] : (item.type || "assign");
    if (m) return `${modName}_${m[1]}`;
  }
  if (item.cmid) return `${item.type || "assign"}_${item.cmid}`;
  if (item.id) return `${item.type || "assign"}_${item.id}`;
  return `${item.courseCode || ""}_${item.title || ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
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
    } catch (e) {}
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
    } catch (e) {}
  }

  const deadlinesMap = new Map();

  // -------------------------------------------------------------
  // 0. Fetch Moodle iCalendar (.ics) Feed If Configured (Permanent, No Expiry)
  // -------------------------------------------------------------
  if (calendarIcalUrl) {
    try {
      const icsItems = await fetchIcsDeadlines(calendarIcalUrl, occurrencesMap, defaultOccurrence);
      icsItems.forEach((item) => {
        const key = getActivityKey(item);
        if (!deadlinesMap.has(key)) {
          deadlinesMap.set(key, item);
        }
      });
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
            assignments.forEach((item) => {
              const key = getActivityKey(item);
              if (deadlinesMap.has(key)) {
                const existing = deadlinesMap.get(key);
                if (item.isSubmittedOnSpectrum) {
                  existing.isSubmittedOnSpectrum = true;
                  existing.isCompleted = true;
                  existing.submissionStatus = "Submitted";
                }
                if (!existing.dueTimestamp && item.dueTimestamp) {
                  existing.dueTimestamp = item.dueTimestamp;
                  existing.dueDate = item.dueDate;
                  existing.formattedTime = item.formattedTime;
                }
              } else {
                if (completedSet.has(String(item.id)) || (item.cmid && completedSet.has(String(item.cmid)))) {
                  item.isCompleted = true;
                }
                deadlinesMap.set(key, item);
              }
            });
            ajaxSuccess = true;
          }
        } catch (ajaxErr) {
          console.warn(`[Spectra] core_course_get_contents notice for ${courseCode}:`, ajaxErr);
        }
      }

      // B. Check /mod/assign/index.php?id={courseId} (Assignments overview page for status enrichment)
      try {
        const assignIndexUrl = `${SPECTRUM_BASE_URL}/mod/assign/index.php?id=${encodeURIComponent(courseId)}`;
        const ctrl1 = typeof AbortController !== "undefined" ? new AbortController() : null;
        const tid1 = ctrl1 ? setTimeout(() => ctrl1.abort(), 12000) : null;
        let res;
        try {
          res = await fetch(assignIndexUrl, { credentials: "include", signal: ctrl1?.signal });
        } finally {
          if (tid1) clearTimeout(tid1);
        }
        if (res && res.ok) {
          const html = await res.text();
          const items = parseCourseAssignmentsIndex(html, courseCode, courseName, studentOcc);
          items.forEach((item) => {
            const key = getActivityKey(item);
            if (deadlinesMap.has(key)) {
              const existing = deadlinesMap.get(key);
              if (item.isSubmittedOnSpectrum) {
                existing.isSubmittedOnSpectrum = true;
                existing.isCompleted = true;
                existing.submissionStatus = "Submitted";
              }
            } else {
              if (completedSet.has(String(item.id)) || (item.cmid && completedSet.has(String(item.cmid)))) {
                item.isCompleted = true;
              }
              deadlinesMap.set(key, item);
            }
          });
        }
      } catch (err) {
        console.warn(`[Spectra] Error checking assign index for ${courseCode}:`, err);
      }

      // C. Check /course/view.php?id={courseId} (Scanned top to bottom as fallback if AJAX didn't capture or wasn't available)
      if (!ajaxSuccess) {
        try {
          const courseViewUrl = `${SPECTRUM_BASE_URL}/course/view.php?id=${encodeURIComponent(courseId)}`;
          const ctrl2 = typeof AbortController !== "undefined" ? new AbortController() : null;
          const tid2 = ctrl2 ? setTimeout(() => ctrl2.abort(), 12000) : null;
          let res;
          try {
            res = await fetch(courseViewUrl, { credentials: "include", signal: ctrl2?.signal });
          } finally {
            if (tid2) clearTimeout(tid2);
          }
          if (res && res.ok) {
            const html = await res.text();
            const items = parseCourseViewSubmissions(html, courseCode, courseName, studentOcc);
            items.forEach((item) => {
              const key = getActivityKey(item);
              if (deadlinesMap.has(key)) {
                const existing = deadlinesMap.get(key);
                if (!existing.dueTimestamp && item.dueTimestamp) {
                  existing.dueTimestamp = item.dueTimestamp;
                  existing.dueDate = item.dueDate;
                  existing.formattedTime = item.formattedTime;
                }
                if (item.isSubmittedOnSpectrum) {
                  existing.isSubmittedOnSpectrum = true;
                  existing.isCompleted = true;
                  existing.submissionStatus = "Submitted";
                }
              } else {
                if (completedSet.has(String(item.id)) || (item.cmid && completedSet.has(String(item.cmid)))) {
                  item.isCompleted = true;
                }
                deadlinesMap.set(key, item);
              }
            });
          }
        } catch (err) {
          console.warn(`[Spectra] Error checking course view submissions for ${courseCode}:`, err);
        }
      }
    }, 2);
  }

  // -------------------------------------------------------------
  // 3. Finalize Urgency, Local Completion, Attendance Exclusion, and Sort
  // -------------------------------------------------------------
  const allDeadlines = Array.from(deadlinesMap.values())
    .filter((item) => !isAttendanceActivity(item))
    .filter((item) => !isOverdueMoreThan100Days(item.dueTimestamp))
    .map((item) => {
    const isCompleted = item.isSubmittedOnSpectrum || completedSet.has(String(item.id)) || completedSet.has(String(item.cmid));
    const urgency = item.dueTimestamp ? calculateUrgency(item.dueTimestamp) : "upcoming";
    return {
      ...item,
      isCompleted,
      urgency
    };
  });

  // Sort: Incomplete first, then by earliest due date. Items with no due date go to the bottom of incomplete.
  allDeadlines.sort((a, b) => {
    if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
    if (a.dueTimestamp && b.dueTimestamp) return a.dueTimestamp - b.dueTimestamp;
    if (a.dueTimestamp && !b.dueTimestamp) return -1;
    if (!a.dueTimestamp && b.dueTimestamp) return 1;
    return (a.title || "").localeCompare(b.title || "");
  });

  return allDeadlines;
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
      if (isOverdueMoreThan100Days(timestamp)) {
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

      const eventUrl = item.action?.url || item.url || `${SPECTRUM_BASE_URL}/mod/${item.modulename || "assign"}/view.php?id=${item.instance || item.id}`;
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
      // Branch 2: Item from cached_deadlines or table scraper
      if ((item.title !== undefined || item.name !== undefined) && (item.dueTimestamp || item.dueDate)) {
        // Standard live deadline object
        if (isAttendanceActivity(item)) continue;
        const timestamp = item.dueTimestamp || (item.dueDate ? Date.parse(item.dueDate) : Date.now());
        if (isOverdueMoreThan100Days(timestamp)) continue;

        const courseCode = item.courseCode || extractCourseCode(item.courseName || item.title || item.name || "");
        const courseId = item.courseId ? String(item.courseId) : "";
        const studentOcc = (courseOccurrences && (courseOccurrences[courseId] || courseOccurrences[courseCode])) || studentOccurrence || "";
        const title = cleanMoodleTitle(item.title || item.name || "");

        // Strict occurrence filter
        if (!isRespectiveOccurrence("", studentOcc, title)) {
          continue;
        }

        const eventId = String(item.id || `deadline-${idx}`);
        const cmid = item.cmid ? String(item.cmid) : "";

        // Preserve verified submission statuses
        const statusText = item.submissionStatus || "";
        const isStatusSubmitted = /\b(?:submitted|submission|graded|grading|selesai|dihantar|dinilai|diserahkan)\b/i.test(statusText) && !/\b(?:no submission|not submitted|belum|tiada|tidak|draft|draf)\b/i.test(statusText);
        const isSubmittedOnSpectrum = Boolean(item.isSubmittedOnSpectrum) || isStatusSubmitted;
        const isCompleted = isSubmittedOnSpectrum || Boolean(item.isCompleted) || completedSet.has(eventId) || (cmid && completedSet.has(cmid));

        normalized.push({
          ...item,
          id: eventId,
          cmid: cmid || eventId,
          title,
          courseCode: courseCode || "N/A",
          courseName: item.courseName || item.courseCode || "N/A",
          dueDate: item.dueDate || new Date(timestamp).toISOString(),
          dueTimestamp: timestamp,
          formattedTime: item.formattedTime || new Date(timestamp).toLocaleString("en-MY", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          }),
          url: item.url || (item.courseId ? `${SPECTRUM_BASE_URL}/course/view.php?id=${item.courseId}` : `${SPECTRUM_BASE_URL}/my/`),
          type: item.type || "assign",
          urgency: calculateUrgency(timestamp),
          isSubmittedOnSpectrum,
          isCompleted,
          submissionStatus: isSubmittedOnSpectrum ? (statusText || "Submitted") : (statusText || "No submission"),
          weight: item.weight || "",
          matchesOccurrence: true
        });
      } else {
        // Old table scraper format
        const code = extractCourseCode(item["Course Code"] || "") || item["Course Code"] || "N/A";
        const title = cleanMoodleTitle(item["Assignment / Task"] || "Assignment");
        const studentOcc = (courseOccurrences && courseOccurrences[code]) || studentOccurrence || "";

        if (!isRespectiveOccurrence("", studentOcc, title)) {
          continue;
        }

        const dueTs = Date.parse(item["Due Date"]) || (Date.now() + 86400000);
        if (isOverdueMoreThan100Days(dueTs)) continue;

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

  // Sort deadlines: pending first, then by earliest due date
  normalized.sort((a, b) => {
    if (a.isCompleted !== b.isCompleted) return a.isCompleted ? 1 : -1;
    if (a.dueTimestamp && b.dueTimestamp) return a.dueTimestamp - b.dueTimestamp;
    if (a.dueTimestamp && !b.dueTimestamp) return -1;
    if (!a.dueTimestamp && b.dueTimestamp) return 1;
    return (a.title || "").localeCompare(b.title || "");
  });

  return normalized;
}

