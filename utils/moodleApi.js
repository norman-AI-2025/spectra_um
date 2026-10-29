/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Manual MoodleSession Cookie Injection & Hybrid Authentication Fallback Engine
 *
 * Precedence:
 * 1. User-provided manualMoodleSession in chrome.storage.local
 * 2. Browser cookie store via chrome.cookies.get({ url: "https://spectrum.um.edu.my", name: "MoodleSession" })
 * 3. AUTH_REQUIRED UI state
 */

import { extractCourseCode, parseCoursePage, parseEnrolledCourses, safeParseHtml } from "./parser.js";

const SPECTRUM_BASE_URL = "https://spectrum.um.edu.my";

export class AuthRequiredError extends Error {
  constructor(message = "No SPeCTRUM session configured. Please provide your MoodleSession cookie.") {
    super(message);
    this.name = "AUTH_REQUIRED";
    this.code = "AUTH_REQUIRED";
  }
}

export class InvalidSessionError extends Error {
  constructor(message = "SPeCTRUM session cookie is invalid or expired.") {
    super(message);
    this.name = "INVALID_SESSION";
    this.code = "INVALID_SESSION";
  }
}

export const AuthExpiredError = InvalidSessionError;

/**
 * Query Chrome's cookie store across multiple URL and domain patterns
 * to reliably locate the active MoodleSession cookie for SPeCTRUM.
 */
export async function getBrowserMoodleCookie() {
  if (typeof chrome === "undefined" || !chrome.cookies) return null;
  try {
    // 1. Direct query with base URL and trailing slash
    let cookie = await chrome.cookies.get({
      url: `${SPECTRUM_BASE_URL}/`,
      name: "MoodleSession"
    });
    if (cookie && cookie.value && cookie.value.trim().length > 0) {
      return cookie.value.trim();
    }

    // 2. Direct query without trailing slash
    cookie = await chrome.cookies.get({
      url: SPECTRUM_BASE_URL,
      name: "MoodleSession"
    });
    if (cookie && cookie.value && cookie.value.trim().length > 0) {
      return cookie.value.trim();
    }

    // 3. Query with /my/ path
    cookie = await chrome.cookies.get({
      url: `${SPECTRUM_BASE_URL}/my/`,
      name: "MoodleSession"
    });
    if (cookie && cookie.value && cookie.value.trim().length > 0) {
      return cookie.value.trim();
    }

    // 4. Query all cookies under spectrum.um.edu.my domain
    const allDomainCookies = await chrome.cookies.getAll({ domain: "spectrum.um.edu.my" });
    if (Array.isArray(allDomainCookies) && allDomainCookies.length > 0) {
      const match = allDomainCookies.find((c) => c.name === "MoodleSession" || c.name.startsWith("MoodleSession") || c.name.toLowerCase() === "moodlesession");
      if (match && match.value && match.value.trim().length > 0) {
        return match.value.trim();
      }
    }

    // 5. Query all cookies matching SPeCTRUM URL
    const allUrlCookies = await chrome.cookies.getAll({ url: SPECTRUM_BASE_URL });
    if (Array.isArray(allUrlCookies) && allUrlCookies.length > 0) {
      const match = allUrlCookies.find((c) => c.name === "MoodleSession" || c.name.startsWith("MoodleSession") || c.name.toLowerCase() === "moodlesession");
      if (match && match.value && match.value.trim().length > 0) {
        return match.value.trim();
      }
    }

    // 6. Query all cookies under parent domain um.edu.my
    const umCookies = await chrome.cookies.getAll({ domain: "um.edu.my" });
    if (Array.isArray(umCookies) && umCookies.length > 0) {
      const match = umCookies.find((c) => c.name === "MoodleSession" || c.name.startsWith("MoodleSession") || c.name.toLowerCase() === "moodlesession");
      if (match && match.value && match.value.trim().length > 0) {
        return match.value.trim();
      }
    }

    // 7. Broadest query across entire cookie store accessible to this extension
    const allCookies = await chrome.cookies.getAll({});
    if (Array.isArray(allCookies) && allCookies.length > 0) {
      // 7A: SPeCTRUM / UM domain with MoodleSession
      const m1 = allCookies.find((c) => {
        const isDom = c.domain && (c.domain.includes("spectrum") || c.domain.includes("um.edu.my"));
        return isDom && (c.name === "MoodleSession" || c.name.startsWith("MoodleSession") || c.name.toLowerCase() === "moodlesession") && c.value && c.value.trim().length > 0;
      });
      if (m1) return m1.value.trim();

      // 7B: Exact name MoodleSession anywhere
      const m2 = allCookies.find((c) => c.name === "MoodleSession" && c.value && c.value.trim().length > 0);
      if (m2) return m2.value.trim();

      // 7C: Any cookie on spectrum.um.edu.my domain formatted as session token (15-45 alphanumeric chars)
      const m3 = allCookies.find((c) => {
        const isSpectrum = c.domain && c.domain.includes("spectrum.um.edu.my");
        return isSpectrum && c.value && /^[a-zA-Z0-9_-]{15,45}$/.test(c.value.trim());
      });
      if (m3) return m3.value.trim();
    }

    // 8. Fallback to moodle_session captured by background service worker
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(["moodle_session"]);
      if (stored.moodle_session) {
        const val = typeof stored.moodle_session === "object" ? (stored.moodle_session.value || "").trim() : String(stored.moodle_session).trim();
        if (val.length > 0) return val;
      }
    }
  } catch (err) {
    console.warn("[Spectra] Querying chrome.cookies encountered notice:", err);
  }
  return null;
}

/**
 * Check if the student currently has an active tab open on SPeCTRUM
 * and request the in-page session state directly from DOM or content script.
 */
export async function getInPageSessionFromActiveTab() {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return null;
  try {
    const allTabs = await chrome.tabs.query({});
    const spectrumTabs = (allTabs || []).filter(
      (t) => t.url && t.url.includes("spectrum.um.edu.my")
    );

    for (const tab of spectrumTabs) {
      if (!tab.id) continue;

      // Method A: Direct DOM inspection inside the tab
      if (chrome.scripting?.executeScript) {
        try {
          const injection = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              // 1. Check window.M.cfg.sesskey
              let sesskey = (window.M && window.M.cfg && window.M.cfg.sesskey) || null;

              // 2. Check hidden inputs
              if (!sesskey) {
                const el = document.querySelector('input[name="sesskey"]');
                if (el && el.value) sesskey = el.value.trim();
              }

              // 3. Check logout link
              if (!sesskey) {
                const link = document.querySelector('a[href*="logout.php?sesskey="]');
                if (link && link.href) {
                  const m = link.href.match(/sesskey=([a-zA-Z0-9]+)/);
                  if (m) sesskey = m[1];
                }
              }

              // 4. Check inline script tags
              if (!sesskey) {
                const scripts = document.querySelectorAll("script");
                for (const s of scripts) {
                  const txt = s.textContent || "";
                  const m = txt.match(/"sesskey":"([^"]+)"/) || txt.match(/M\.cfg\.sesskey\s*=\s*"([^"]+)"/);
                  if (m) {
                    sesskey = m[1];
                    break;
                  }
                }
              }

              // 5. Check document.cookie for MoodleSession
              let cookieVal = null;
              try {
                const m = document.cookie.match(/MoodleSession=([a-zA-Z0-9_-]+)/i);
                if (m) cookieVal = m[1];
              } catch (e) { }

              // 6. Check user name
              const nameEl = document.querySelector(".usertext, .logininfo a, .usermenu .usertext, span.user-name");
              const userName = nameEl ? nameEl.textContent.trim() : "UM Student";

              // 7. Check avatar
              const avatarEl = document.querySelector(".userpicture, .userbutton img, .avatars img");
              const userAvatarUrl = avatarEl ? (avatarEl.getAttribute("src") || "") : "";

              return {
                authenticated: Boolean(sesskey),
                sesskey,
                userName,
                userAvatarUrl,
                cookie: cookieVal
              };
            }
          });

          if (injection && injection[0]?.result?.authenticated && injection[0].result.sesskey) {
            return injection[0].result;
          }
        } catch (scriptErr) {
          console.warn("[Spectra] In-tab direct script inspection notice:", scriptErr);
        }
      }

      // Method B: Send message to content script
      try {
        const res = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { action: "GET_INPAGE_SESSION" }, (response) => {
            if (chrome.runtime.lastError || !response || !response.success) {
              resolve(null);
            } else {
              resolve(response.data);
            }
          });
        });
        if (res && res.authenticated && res.sesskey) {
          return res;
        }
      } catch (e) { }
    }
  } catch (err) { }
  return null;
}

/**
 * Retrieve active session cookie following precedence:
 * 1. chrome.storage.local "manualMoodleSession"
 * 2. chrome.cookies store for spectrum.um.edu.my
 * Returns { source: "manual" | "browser" | null, cookieValue: string | null }
 */
export async function getEffectiveSessionCookie() {
  // Step 1: Check chrome.storage.local for manualMoodleSession / stored token
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(["manualMoodleSession", "manual_moodle_session", "moodle_session"]);
      const manualToken = (stored.manualMoodleSession || stored.manual_moodle_session || "").trim();
      if (manualToken.length > 0) {
        return {
          source: "manual",
          cookieValue: manualToken
        };
      }
      const moodleVal = typeof stored.moodle_session === "object" && stored.moodle_session !== null
        ? (stored.moodle_session.value || "").trim()
        : (typeof stored.moodle_session === "string" ? stored.moodle_session.trim() : "");
      if (moodleVal.length > 0) {
        return {
          source: "manual",
          cookieValue: moodleVal
        };
      }
    } catch (err) {
      console.warn("[Spectra] Could not read manualMoodleSession from storage:", err);
    }
  }

  // Step 2: Fall back to live browser cookie
  const browserCookie = await getBrowserMoodleCookie();
  if (browserCookie) {
    return {
      source: "browser",
      cookieValue: browserCookie
    };
  }

  // Step 3: Neither exists
  return {
    source: null,
    cookieValue: null
  };
}

/**
 * Dynamically write session cookie to Chrome's cookie store with persistent expiration
 * so it survives browser restarts and all subsequent native fetch() calls pass it.
 */
export async function injectCookieToBrowser(sessionCookie) {
  if (!sessionCookie) return false;
  const clean = sessionCookie.trim();
  let injected = false;

  // Persistent expiration: 30 days into future so Chrome keeps it across restarts
  const expirationDate = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60);

  // 1. Programmatically write to Chrome's cookie store for SPeCTRUM
  if (typeof chrome !== "undefined" && chrome.cookies?.set) {
    try {
      await chrome.cookies.set({
        url: `${SPECTRUM_BASE_URL}/`,
        name: "MoodleSession",
        value: clean,
        path: "/",
        secure: true,
        sameSite: "lax",
        expirationDate
      });
      injected = true;
      console.log("[Spectra] Injected persistent MoodleSession cookie into browser store.");
    } catch (err) {
      console.warn("[Spectra] chrome.cookies.set failed:", err);
    }
  }

  // 2. Set document.cookie directly if in SPeCTRUM domain context
  if (typeof document !== "undefined" && typeof location !== "undefined" && location.hostname?.includes("spectrum.um.edu.my")) {
    try {
      const maxAge = 30 * 24 * 60 * 60;
      document.cookie = `MoodleSession=${clean}; path=/; domain=spectrum.um.edu.my; max-age=${maxAge}; secure; samesite=lax`;
      document.cookie = `MoodleSession=${clean}; path=/; max-age=${maxAge}; secure; samesite=lax`;
      injected = true;
    } catch (e) { }
  }

  // 3. Inject cookie into active SPeCTRUM tabs if tabs & scripting permissions available
  if (typeof chrome !== "undefined" && chrome.tabs?.query && chrome.scripting?.executeScript) {
    try {
      const tabs = await chrome.tabs.query({ url: "*://spectrum.um.edu.my/*" });
      for (const tab of tabs) {
        if (tab.id) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (val) => {
              const maxAge = 30 * 24 * 60 * 60;
              document.cookie = `MoodleSession=${val}; path=/; domain=spectrum.um.edu.my; max-age=${maxAge}; secure; samesite=lax`;
              document.cookie = `MoodleSession=${val}; path=/; max-age=${maxAge}; secure; samesite=lax`;
            },
            args: [clean]
          }).catch(() => { });
        }
      }
    } catch (e) { }
  }

  return injected;
}

/**
 * Register dynamic DeclarativeNetRequest rule to automatically attach
 * Cookie: MoodleSession=<token> on all extension fetches to spectrum.um.edu.my.
 */
export async function setupDeclarativeCookieRule(token) {
  if (!token || !token.trim()) return;
  if (typeof chrome !== "undefined" && chrome.declarativeNetRequest?.updateDynamicRules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1001],
        addRules: [
          {
            id: 1001,
            priority: 1,
            action: {
              type: "modifyHeaders",
              requestHeaders: [
                {
                  header: "Cookie",
                  operation: "set",
                  value: `MoodleSession=${token.trim()}`
                }
              ]
            },
            condition: {
              urlFilter: "||spectrum.um.edu.my",
              resourceTypes: ["xmlhttprequest", "sub_frame", "main_frame", "other"]
            }
          }
        ]
      });
      console.log("[Spectra] DeclarativeNetRequest dynamic cookie header rule registered.");
    } catch (err) {
      console.warn("[Spectra] declarativeNetRequest rule update notice:", err);
    }
  }
}

/**
 * Remove DeclarativeNetRequest rule 1001 when a session is invalidated or expired
 * so stale cookies do not corrupt future requests.
 */
export async function removeDeclarativeCookieRule() {
  if (typeof chrome !== "undefined" && chrome.declarativeNetRequest?.updateDynamicRules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [1001]
      });
      console.log("[Spectra] DeclarativeNetRequest dynamic cookie header rule cleared.");
    } catch (err) { }
  }
}

/**
 * Verify session cookie against live SPeCTRUM portal and extract dynamic CSRF sesskey
 * Throws InvalidSessionError if redirected to SSO / login, or if sesskey missing
 */
export async function verifyAndFetchSesskey(sessionCookie) {
  if (!sessionCookie || !sessionCookie.trim()) {
    throw new AuthRequiredError("Session cookie cannot be empty.");
  }

  const cleanCookie = sessionCookie.trim();

  // 1. Programmatically attach DeclarativeNetRequest header rule so all native fetch() calls transmit cookie
  await setupDeclarativeCookieRule(cleanCookie);

  // 2. Align browser cookie store
  await injectCookieToBrowser(cleanCookie);

  // 3. Query SPeCTRUM Dashboard (https://spectrum.um.edu.my/my/) with timeout
  let response;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    response = await fetch(`${SPECTRUM_BASE_URL}/my/`, {
      method: "GET",
      credentials: "include",
      signal: controller ? controller.signal : undefined,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
  } catch (netErr) {
    if (netErr.name === "AbortError") {
      throw new Error("Connection to SPeCTRUM timed out (server took too long to respond).");
    }
    throw new Error(`Network error connecting to SPeCTRUM: ${netErr.message}`);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  // 4. Inspect response URL and redirects
  if (
    (response.redirected && (
      response.url.includes("/login/") ||
      response.url.includes("microsoftonline") ||
      response.url.includes("oidc") ||
      response.url.includes("sso")
    )) ||
    response.status === 401 ||
    response.status === 403
  ) {
    throw new InvalidSessionError("Redirected to UM login portal. The MoodleSession cookie is expired or invalid.");
  }

  const html = await response.text();

  // Validate if returned page is unauthenticated login form
  if (
    html.includes("You are not logged in") ||
    html.includes('action="https://spectrum.um.edu.my/login/index.php"') ||
    html.includes('name="logintoken"')
  ) {
    throw new InvalidSessionError("SPeCTRUM returned unauthenticated state. Please re-check your MoodleSession token.");
  }

  // 5. Extract CSRF sesskey
  let sesskey = null;
  const jsonMatch = html.match(/"sesskey":"([^"]+)"/);
  if (jsonMatch) sesskey = jsonMatch[1];

  if (!sesskey) {
    const inputMatch = html.match(/name="sesskey"\s+value="([^"]+)"/i) || html.match(/sesskey=([a-zA-Z0-9]+)/);
    if (inputMatch) sesskey = inputMatch[1];
  }

  if (!sesskey) {
    const cfgMatch = html.match(/M\.cfg\s*=\s*\{[^}]*"sesskey"\s*:\s*"([^"]+)"/);
    if (cfgMatch) sesskey = cfgMatch[1];
  }

  if (!sesskey) {
    throw new InvalidSessionError("No CSRF sesskey found in SPeCTRUM response. Session may be expired.");
  }

  // 6. Extract Student Profile Metadata
  let userName = "UM Student";
  let userId = "";
  let userAvatarUrl = "";

  const userMatch = html.match(/class="usertext[^"]*">([^<]+)<\/span>/i) || html.match(/class="userbutton"[^>]*>.*?<span class="usertext">([^<]+)<\/span>/is);
  if (userMatch && userMatch[1].trim()) {
    userName = userMatch[1].trim();
  }

  try {
    const doc = safeParseHtml(html);
    if (doc) {
      // Student Name DOM fallback
      if (userName === "UM Student") {
        const nameEl = doc.querySelector(".usertext, .logininfo a, .usermenu .usertext, span.user-name");
        if (nameEl && nameEl.textContent.trim()) {
          userName = nameEl.textContent.trim();
        } else {
          const altMatch = html.match(/alt="Picture of ([^"]+)"/i);
          if (altMatch) userName = altMatch[1].trim();
        }
      }

      // Student User ID
      const userProfileLink = doc.querySelector('a[href*="/user/profile.php?id="], a[href*="/user/view.php?id="]');
      if (userProfileLink) {
        const idMatch = userProfileLink.href.match(/id=(\d+)/);
        if (idMatch) userId = idMatch[1];
      }

      // Avatar URL
      const avatarEl = doc.querySelector(".userpicture, .userbutton img, .avatars img");
      if (avatarEl) {
        userAvatarUrl = avatarEl.getAttribute("src") || "";
      }
    }
  } catch (domErr) {
    console.warn("[Spectra] Could not parse student profile elements:", domErr);
  }

  // 7. Cache verified session in chrome.storage.local
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({
      manualMoodleSession: cleanCookie,
      verifiedSesskey: sesskey,
      userName,
      userId,
      userAvatarUrl,
      sessionStatus: "connected",
      sessionLastVerified: Date.now()
    });
  }

  console.log(`[Spectra] Session verified successfully! Student: ${userName} (ID: ${userId || "N/A"})`);

  return {
    success: true,
    sesskey,
    userName,
    userId,
    userAvatarUrl,
    authenticated: true
  };
}

/**
 * High-level session discovery orchestrator.
 * Dynamically tests candidate cookies with automatic fallback:
 * 1. Live browser cookie from Chrome cookies store
 * 2. Stored manualMoodleSession
 * 3. Active SPeCTRUM in-page tab session
 */
export async function getSessionContext() {
  const browserCookie = await getBrowserMoodleCookie();

  let storedManual = "";
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const st = await chrome.storage.local.get(["manualMoodleSession", "manual_moodle_session", "moodle_session"]);
      storedManual = (st.manualMoodleSession || st.manual_moodle_session || "").trim();
      if (!storedManual && st.moodle_session) {
        storedManual = typeof st.moodle_session === "object"
          ? (st.moodle_session.value || "").trim()
          : String(st.moodle_session).trim();
      }
    } catch (e) { }
  }

  // Build candidate list: manual first if configured, followed by live browser cookie
  const candidates = [];
  if (storedManual) {
    candidates.push({ source: "manual", cookie: storedManual });
  }
  if (browserCookie && browserCookie !== storedManual) {
    candidates.push({ source: "browser", cookie: browserCookie });
  }

  // If candidate cookies are present, attempt verification with fallback
  let lastErr = null;
  for (const { source, cookie } of candidates) {
    try {
      const result = await verifyAndFetchSesskey(cookie);
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        await chrome.storage.local.set({
          manualMoodleSession: cookie,
          moodle_session_valid: true
        });
      }
      return {
        ...result,
        source
      };
    } catch (candErr) {
      console.warn(`[Spectra] Candidate ${source} session check failed:`, candErr.message || candErr);
      lastErr = candErr;
    }
  }

  // If no candidates or candidates failed, check open tab in-page session
  const inPageTab = await getInPageSessionFromActiveTab();
  if (inPageTab && inPageTab.authenticated && inPageTab.sesskey) {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({
        verifiedSesskey: inPageTab.sesskey,
        userName: inPageTab.userName || "UM Student",
        sessionStatus: "connected",
        sessionLastVerified: Date.now()
      });
    }
    return {
      success: true,
      sesskey: inPageTab.sesskey,
      userName: inPageTab.userName || "UM Student",
      userId: inPageTab.userId || "",
      userAvatarUrl: inPageTab.userAvatarUrl || "",
      authenticated: true,
      source: "active_tab"
    };
  }

  // If all failed, clear any lingering declarative header rule
  await removeDeclarativeCookieRule();

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    if (candidates.length === 0) {
      await chrome.storage.local.set({ sessionStatus: "unset" });
    } else {
      await chrome.storage.local.set({ sessionStatus: "expired", moodle_session_valid: false });
    }
  }

  if (candidates.length === 0) {
    throw new AuthRequiredError();
  }
  throw lastErr || new InvalidSessionError("Could not connect to SPeCTRUM. Session is invalid or expired.");
}

/**
 * The exact standalone in-page scraper injected directly into SPeCTRUM page tabs.
 * Runs in first-party browser context with native SameSite cookie privileges.
 */
export async function inPageSpectrumScraper(moodleSession) {
  const MOODLE_SESSION = moodleSession;

  console.log("%c[1/4] Setting session cookie...", "color: #3b82f6; font-weight: bold;");
  // Set the cookie directly in the browser's context
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
    let sesskeyMatch = html.match(/"sesskey":"([^"]+)"/);
    if (sesskeyMatch) {
      sesskey = sesskeyMatch[1];
    } else {
      const inputMatch = html.match(/name="sesskey"\s+value="([^"]+)"/i) || html.match(/sesskey=([a-zA-Z0-9]+)/);
      if (inputMatch) sesskey = inputMatch[1];
    }
    if (!sesskey) {
      const cfgMatch = html.match(/M\.cfg\s*=\s*\{[^}]*"sesskey"\s*:\s*"([^"]+)"/);
      if (cfgMatch) sesskey = cfgMatch[1];
    }
    if (!sesskey && typeof window !== "undefined" && window.M?.cfg?.sesskey) {
      sesskey = window.M.cfg.sesskey;
    }
    if (!sesskey) {
      throw new Error("Could not parse sesskey from dashboard. Check if session is valid.");
    }

    // 2. Extract logged-in user name
    const userMatch = html.match(/class="usertext[^"]*">([^<]+)<\/span>/i) || html.match(/class="userbutton"[^>]*>.*?<span class="usertext">([^<]+)<\/span>/is);
    if (userMatch) {
      userName = userMatch[1].trim();
    } else if (typeof document !== "undefined") {
      const nameEl = document.querySelector(".usertext, .logininfo a, .usermenu .usertext, span.user-name");
      if (nameEl && nameEl.textContent.trim()) userName = nameEl.textContent.trim();
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
  let courseData = null;
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

    const [coursesParsed] = await courseRes.json();
    courseData = coursesParsed;

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

  return {
    success: true,
    sesskey,
    userName,
    events: [],
    courses,
    rawCalendarEvents: [],
    rawCourses: (courseData && courseData.data && courseData.data.courses) || []
  };
}

/**
 * Rebuilt Backend Scraper Injector:
 * Injects testSpectrumScraper directly into SPeCTRUM browser page context
 * and returns the extracted console data payload.
 */
export async function injectAndScrapeSpectrum(moodleSession) {
  if (!moodleSession || !moodleSession.trim()) {
    throw new AuthRequiredError("Session cookie cannot be empty.");
  }
  const token = moodleSession.trim();

  // 1. Setup declarative header rule & inject into browser cookie store
  await setupDeclarativeCookieRule(token);
  await injectCookieToBrowser(token);

  // 2. Locate an existing open tab on spectrum.um.edu.my (never create disruptive background tabs)
  let result = null;
  if (typeof chrome !== "undefined" && chrome.tabs && chrome.scripting) {
    try {
      const tabs = await chrome.tabs.query({ url: "*://spectrum.um.edu.my/*" });
      if (tabs && tabs.length > 0) {
        const targetTab = tabs.find((t) => t.active) || tabs[0];
        if (targetTab && targetTab.id) {
          const injectedResults = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            func: inPageSpectrumScraper,
            args: [token]
          });

          if (injectedResults && injectedResults[0] && injectedResults[0].result) {
            result = injectedResults[0].result;
          }
        }
      }
    } catch (scriptErr) {
      console.warn("[Spectra] In-tab script execution notice:", scriptErr);
    }
  }

  // If in-tab execution produced data
  if (result) {
    if (!result.success) {
      throw new InvalidSessionError(result.error || "SPeCTRUM handshake failed. Please verify token.");
    }

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.set({
        manualMoodleSession: token,
        verifiedSesskey: result.sesskey,
        userName: result.userName,
        sessionStatus: "connected",
        sessionLastVerified: Date.now(),
        cached_courses: result.courses,
        cached_raw_courses: result.rawCourses
      });
      await chrome.storage.local.remove(["cached_raw_events"]).catch(() => { });
    }

    return result;
  }

  // 3. Direct verification via HTTP with declarativeNetRequest header
  const directResult = await verifyAndFetchSesskey(token);
  return directResult;
}

/**
 * Return current stored MoodleSession cookie value if available.
 */
export async function getStoredMoodleCookie() {
  const { cookieValue } = await getEffectiveSessionCookie();
  return cookieValue;
}

/**
 * Save manual MoodleSession token to local storage and verify it immediately.
 * Validates alphanumeric string (~26 characters), injects testSpectrumScraper into SPeCTRUM,
 * and confirms dashboard access, sesskey, deadlines, and courses.
 */
export async function saveManualSession(rawToken) {
  if (!rawToken || !rawToken.trim()) {
    throw new Error("Token cannot be empty");
  }

  const token = rawToken.trim();

  // Validate format (alphanumeric, 15 to 45 characters, typically ~26 chars)
  if (!/^[a-zA-Z0-9_-]{15,45}$/.test(token)) {
    throw new Error("Invalid format. MoodleSession cookie is typically ~26 alphanumeric characters.");
  }

  // Persist token in local storage
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ manualMoodleSession: token });
  }

  // Inject into Chrome cookies store
  await injectCookieToBrowser(token);

  // Inject scraper and verify
  return await injectAndScrapeSpectrum(token);
}

/**
 * Auto-detect MoodleSession from browser cookie store, save it, and verify.
 */
export async function autoDetectSession() {
  let token = (await getBrowserMoodleCookie()) || "";

  // 1. If not found via direct cookie query, check stored moodle_session from background worker
  if (!token && typeof chrome !== "undefined" && chrome.storage?.local) {
    try {
      const stored = await chrome.storage.local.get(["moodle_session", "spectrum_live_session"]);
      if (stored.moodle_session) {
        token = typeof stored.moodle_session === "object" ? (stored.moodle_session.value || "").trim() : String(stored.moodle_session).trim();
      }
      if (!token && stored.spectrum_live_session?.cookie) {
        token = stored.spectrum_live_session.cookie.trim();
      }
    } catch (e) { }
  }

  // 2. Check active SPeCTRUM tab in Chrome
  if (!token) {
    const tabSession = await getInPageSessionFromActiveTab();
    if (tabSession && tabSession.authenticated && tabSession.sesskey) {
      if (tabSession.cookie) {
        token = tabSession.cookie.trim();
      } else {
        if (typeof chrome !== "undefined" && chrome.storage?.local) {
          await chrome.storage.local.set({
            verifiedSesskey: tabSession.sesskey,
            userName: tabSession.userName || "UM Student",
            sessionStatus: "connected",
            sessionLastVerified: Date.now()
          });
        }
        return {
          success: true,
          sesskey: tabSession.sesskey,
          userName: tabSession.userName || "UM Student",
          userId: tabSession.userId || "",
          userAvatarUrl: tabSession.userAvatarUrl || "",
          events: [],
          courses: tabSession.courses || []
        };
      }
    }
  }

  if (!token) {
    throw new Error("No MoodleSession cookie found for spectrum.um.edu.my in browser. Please sign in to SPeCTRUM in Chrome first.");
  }

  token = token.trim();

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ manualMoodleSession: token });
  }

  await injectCookieToBrowser(token);

  return await injectAndScrapeSpectrum(token);
}

export { getLiveEnrolledCourses, getLiveCourseMaterials, fetchLiveEnrolledCourses, fetchLiveCourseMaterials, fetchLiveAnnouncements, fetchCourseContentsViaAjax } from "./courses.js";
export { fetchCourseAttendance, fetchLiveAllAttendance, autoSubmitAttendance, scanAndAutoRecordAttendance, formatAttendanceTelegram, fetchCourseGradebookAttendance } from "./attendance.js";
export { fetchLiveDeadlines, fetchIcsDeadlines, normalizeHydratedDeadlines, getTaskFingerprint, deduplicateDeadlinesList, autoDiscoverMoodleIcalUrl, extractIcalUrlFromHtml } from "./calendar.js";

