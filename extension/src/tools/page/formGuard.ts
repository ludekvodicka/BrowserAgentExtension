// The isolated world cannot intercept a page handler's direct form.submit(). This short-lived
// main-world guard covers native form methods while an agent action runs, then restores them.
export function formGuard(operation: "start" | "finish", id: string, origin: string): boolean {
  if (window.origin === "null" || window.origin !== origin)
    return false;
  const context = window as typeof window & { __browserAgentFormGuard?: { id: string; blocked: boolean; restore: () => void } };
  if (operation === "finish") {
    const guard = context.__browserAgentFormGuard;
    if (!guard || guard.id !== id)
      return false;
    guard.restore();
    return guard.blocked;
  } else if (operation !== "start")
    throw new Error("Unknown form guard operation.");
  context.__browserAgentFormGuard?.restore();
  const prototype = HTMLFormElement.prototype;
  const submit = prototype.submit;
  const requestSubmit = prototype.requestSubmit;
  const guard = { id, blocked: false, restore: () => {
    if (prototype.submit === refuse)
      prototype.submit = submit;
    if (prototype.requestSubmit === refuse)
      prototype.requestSubmit = requestSubmit;
    if (context.__browserAgentFormGuard === guard)
      delete context.__browserAgentFormGuard;
    clearTimeout(timer);
  } };
  function refuse(this: HTMLFormElement): void {
    guard.blocked = true;
    this.style.outline = "3px solid #dc2626";
  }
  const timer = setTimeout(() => guard.restore(), 3000);
  context.__browserAgentFormGuard = guard;
  prototype.submit = refuse;
  prototype.requestSubmit = refuse;
  return true;
}
