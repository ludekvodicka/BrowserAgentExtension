// Runs in Outlook's main world from document_start. Outlook keeps its tokens in an encrypted cache, so the
// tool reuses the authorization the page itself sends to the Outlook API; the value never leaves the page.
(() => {
  const scope = window as unknown as Record<symbol, unknown>;
  const key = Symbol.for("browserAgent.outlook");
  if (scope[key])
    return;
  let latest: string | null = null;
  const remember = (authorization: string | null) => {
    if (!authorization || !/^Bearer /i.test(authorization))
      return;
    try {
      const payload = JSON.parse(atob(authorization.slice(7).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload.aud === "https://outlook.office.com")
        latest = authorization;
    } catch { /* not a JWT for us */ }
  };
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    try {
      remember(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization"));
    } catch { /* never break the page */ }
    return originalFetch.call(this, input, init);
  };
  const setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
    if (name.toLowerCase() === "authorization")
      remember(value);
    return setRequestHeader.call(this, name, value);
  };
  Object.defineProperty(scope, key, { value: Object.freeze({ authorization: () => latest }) });
})();
