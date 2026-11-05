export type PageLocator = { ref?: string; selector?: string; role?: string; name?: string };
export type PageAction = "click" | "fill" | "type" | "select" | "check" | "press" | "scroll" | "hover" | "highlight";
export type PageCommand = { operation: "snapshot" | "read" | "act"; origins: string[]; generation: string; limit: number;
  locator?: PageLocator; action?: PageAction; text?: string; values?: string[]; checked?: boolean; key?: string;
  x?: number; y?: number; format?: "text" | "html"; newTab?: boolean; label?: string };
export type PageElement = { ref: string; role: string; name: string; value?: string; checked?: boolean; disabled?: boolean };
export type PageDocumentResult = { ok: true; elements?: PageElement[]; truncated?: boolean; content?: string; status?: string; origin?: string; url?: string }
  | { ok: false; code: "permission_missing" | "tab_not_ready" | "tool_args_invalid" | "tool_denied"; message: string };

// Serialized into the isolated world: every runtime helper stays inside this function.
export function pageDocument(command: PageCommand): PageDocumentResult {
  const fail = (code: "permission_missing" | "tab_not_ready" | "tool_args_invalid" | "tool_denied", message: string): PageDocumentResult => ({ ok: false, code, message });
  const documentOrigin = window.origin;
  if (documentOrigin === "null" || !command.origins.includes(documentOrigin))
    return fail("permission_missing", "This frame's exact origin is not granted.");
  type Snapshot = { generation: string; url: string; root: Element; refs: Map<string, Element> };
  const context = globalThis as typeof globalThis & { __browserAgentSnapshot?: Snapshot };
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  function visible(element: Element): boolean {
    if (!element.isConnected || !element.getClientRects().length)
      return false;
    let current: Element | null = element;
    while (current) {
      const style = getComputedStyle(current);
      if (current.hasAttribute("hidden") || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true"
        || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")
        return false;
      current = current.parentElement ?? (current.getRootNode() as ShadowRoot).host ?? null;
    }
    return true;
  }
  function scan(root: Document | ShadowRoot | Element): { elements: Element[]; truncated: boolean } {
    const result: { elements: Element[]; truncated: boolean } = { elements: [], truncated: false };
    function visit(parent: Document | ShadowRoot | Element): void {
      for (const element of parent.children) {
        if (result.elements.length >= 10_000) {
          result.truncated = true;
          return;
        }
        result.elements.push(element);
        if (element.shadowRoot)
          visit(element.shadowRoot);
        visit(element);
        if (result.truncated)
          return;
      }
    }
    visit(root);
    return result;
  }
  function role(element: Element): string {
    const explicit = element.getAttribute("role")?.split(/\s/)[0];
    if (explicit)
      return explicit;
    if (element instanceof HTMLInputElement) {
      switch (element.type) {
        case "hidden": return "";
        case "checkbox": return "checkbox";
        case "radio": return "radio";
        case "range": return "slider";
        case "number": return "spinbutton";
        case "button": case "submit": case "reset": case "image": return "button";
        default: return "textbox";
      }
    }
    if (element instanceof HTMLTextAreaElement || element.getAttribute("contenteditable") === "true" || element.getAttribute("contenteditable") === "")
      return "textbox";
    if (element instanceof HTMLButtonElement || element.tagName === "SUMMARY")
      return "button";
    if (element instanceof HTMLSelectElement)
      return element.multiple ? "listbox" : "combobox";
    if (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
      return "link";
    return element.hasAttribute("tabindex") ? "generic" : "";
  }
  function name(element: Element): string {
    const ids = element.getAttribute("aria-labelledby")?.trim().split(/\s+/);
    const labelled = ids?.map(id => (element.getRootNode() as Document | ShadowRoot).getElementById(id)?.textContent ?? "").join(" ");
    const labels = "labels" in element ? (element as HTMLInputElement).labels : null;
    return normalize(labelled || element.getAttribute("aria-label") || (labels?.length ? [...labels].map(label => label.textContent).join(" ") : "")
      || element.getAttribute("alt") || (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type) ? element.value : "")
      || (role(element) === "textbox" ? "" : element.textContent) || element.getAttribute("title") || element.getAttribute("placeholder") || "").slice(0, 300);
  }

  if (command.operation === "snapshot") {
    const refs = new Map<string, Element>();
    const entries: PageElement[] = [];
    const scanned = scan(document);
    let truncated = scanned.truncated;
    for (const element of scanned.elements) {
      const elementRole = role(element);
      if (!elementRole || !visible(element))
        continue;
      if (entries.length >= command.limit) {
        truncated = true;
        break;
      }
      const ref = `e${entries.length + 1}`;
      refs.set(ref, element);
      const entry: PageElement = { ref, role: elementRole, name: name(element) };
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)
        entry.value = element instanceof HTMLInputElement && element.type === "password" ? "[redacted]" : element.value.slice(0, 1000);
      else if (element instanceof HTMLElement && element.isContentEditable)
        entry.value = (element.textContent ?? "").slice(0, 1000);
      if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type))
        entry.checked = element.checked;
      else if (element.hasAttribute("aria-checked"))
        entry.checked = element.getAttribute("aria-checked") === "true";
      if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true")
        entry.disabled = true;
      entries.push(entry);
    }
    context.__browserAgentSnapshot = { generation: command.generation, url: location.href, root: document.documentElement, refs };
    return { ok: true, elements: entries, truncated, origin: documentOrigin };
  } else if (command.operation !== "read" && command.operation !== "act")
    throw new Error("Unknown page operation.");

  const locator = command.locator;
  let target: Element | undefined;
  if (locator?.ref) {
    const snapshot = context.__browserAgentSnapshot;
    if (!snapshot || snapshot.generation !== command.generation || snapshot.url !== location.href || snapshot.root !== document.documentElement)
      return fail("tab_not_ready", "Stale element ref. Take a new page.snapshot before using refs.");
    target = snapshot.refs.get(locator.ref);
    if (!target?.isConnected)
      return fail("tab_not_ready", "Stale or missing element ref. Take a new page.snapshot.");
  } else if (locator) {
    let matches: Element[];
    try {
      const scanned = scan(document);
      if (scanned.truncated)
        return fail("tab_not_ready", "The DOM scan was truncated; locator uniqueness cannot be established. Use a snapshot ref.");
      matches = scanned.elements.filter(element => visible(element) && (locator.selector ? element.matches(locator.selector)
        : role(element) === locator.role && name(element) === locator.name));
    } catch {
      return fail("tool_args_invalid", "Invalid CSS selector.");
    }
    if (matches.length !== 1)
      return fail("tab_not_ready", `Locator matches ${matches.length} visible elements; use a unique ref from page.snapshot.`);
    target = matches[0];
  } else target = document.body;
  if (!target || !visible(target))
    return fail("tab_not_ready", "The element is not visible. Take a new snapshot after the page is ready.");

  if (command.operation === "read") {
    let content: string;
    if (command.format === "html") {
      const clone = target.cloneNode(true) as Element;
      for (const element of [clone, ...clone.querySelectorAll("*")]) {
        if (element.matches("script,style,noscript,input[type=hidden],[hidden],[aria-hidden=true]"))
          element.remove();
        for (const attribute of [...element.attributes])
          if (/^on/i.test(attribute.name) || attribute.name === "value" && element.matches("input[type=password]"))
            element.removeAttribute(attribute.name);
      }
      content = clone.outerHTML;
    } else if (command.format === "text" || command.format === undefined) {
      const parts: string[] = [];
      function read(root: Node): void {
        for (const child of root.childNodes)
          if (child.nodeType === Node.TEXT_NODE)
            parts.push(child.textContent ?? "");
          else if (child instanceof Element && !child.matches("script,style,noscript,iframe") && visible(child)) {
            read(child);
            if (child.shadowRoot)
              read(child.shadowRoot);
            parts.push(" ");
          }
      }
      read(target);
      if (target.shadowRoot)
        read(target.shadowRoot);
      content = normalize(parts.join(""));
    } else throw new Error("Unknown read format.");
    return { ok: true, content: content.slice(0, command.limit), truncated: content.length > command.limit };
  }

  // Highlight only shows the user an element, so it also marks disabled controls.
  if (command.action === "highlight") {
    for (const previous of document.querySelectorAll("[data-browser-agent-highlight]"))
      previous.remove();
    target.scrollIntoView?.({ block: "center", inline: "nearest" });
    const box = document.createElement("div");
    box.setAttribute("data-browser-agent-highlight", "");
    box.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:3px solid #f97316;"
      + "border-radius:4px;box-shadow:0 0 0 4px rgba(249,115,22,.35),0 0 16px 4px rgba(249,115,22,.6);";
    if (command.label) {
      const caption = document.createElement("div");
      caption.textContent = command.label;
      caption.style.cssText = "position:absolute;left:-3px;bottom:100%;margin-bottom:4px;padding:2px 8px;border-radius:4px;background:#f97316;"
        + "color:#fff;font:600 13px/1.4 system-ui,sans-serif;white-space:nowrap;";
      box.append(caption);
    }
    document.documentElement.append(box);
    const expires = Date.now() + 20_000;
    const place = () => {
      if (!box.isConnected)
        return;
      if (Date.now() > expires || !target!.isConnected) {
        box.remove();
        return;
      }
      const rect = target!.getBoundingClientRect();
      Object.assign(box.style, { left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` });
      requestAnimationFrame(place);
    };
    place();
    return { ok: true, status: "highlighted" };
  }

  if (!(target instanceof HTMLElement) || target.matches(":disabled") || target.getAttribute("aria-disabled") === "true")
    return fail("tab_not_ready", "The element cannot be operated or is disabled.");

  function insert(text: string, replace: boolean): boolean {
    target!.scrollIntoView?.({ block: "nearest" });
    (target as HTMLElement).focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (target.readOnly || target instanceof HTMLInputElement && !["text", "search", "email", "url", "tel", "password", "number"].includes(target.type))
        return false;
      const start = replace ? 0 : target.selectionStart ?? target.value.length;
      const end = replace ? target.value.length : target.selectionEnd ?? target.value.length;
      const next = target.value.slice(0, start) + text + target.value.slice(end);
      const setter = Object.getOwnPropertyDescriptor(target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(target, next);
      if (target.selectionStart !== null)
        target.setSelectionRange(start + text.length, start + text.length);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (target instanceof HTMLElement && target.isContentEditable) {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      if (!replace)
        range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return document.execCommand("insertText", false, text);
    }
    return false;
  }
  switch (command.action) {
    case "click": {
      if (!command.newTab) {
        target.click();
        break;
      }
      // The extension opens the link itself: a synthetic Ctrl+click is untrusted, so the popup blocker stops it.
      const link = target.closest("a[href], area[href]") as HTMLAnchorElement | HTMLAreaElement | null;
      if (!link || !["http:", "https:"].includes(link.protocol))
        return fail("tool_args_invalid", "newTab needs a link with an http(s) address. This element is not such a link; click it without newTab.");
      return { ok: true, status: "link", url: link.href };
    }
    case "fill": case "type":
      if (!insert(command.text!, command.action === "fill"))
        return fail("tab_not_ready", "This is not an editable text field, or the editor refused text insertion.");
      break;
    case "select":
      if (!(target instanceof HTMLSelectElement) || !target.multiple && command.values!.length !== 1)
        return fail("tool_args_invalid", "Select needs a select element and one value unless it allows multiple values.");
      if (command.values!.some(value => ![...target.options].some(option => option.value === value && !option.disabled)))
        return fail("tool_args_invalid", "A requested option is absent or disabled.");
      for (const option of target.options)
        option.selected = command.values!.includes(option.value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      break;
    case "check":
      if (!(target instanceof HTMLInputElement) || !["checkbox", "radio"].includes(target.type) || target.type === "radio" && !command.checked)
        return fail("tool_args_invalid", "Check needs a checkbox, or a radio with checked:true.");
      if (target.checked !== command.checked)
        target.click();
      if (target.checked !== command.checked)
        return fail("tab_not_ready", "The page did not accept the checked state.");
      break;
    case "press": {
      target.focus();
      const parts = command.key!.split("+");
      const key = parts.at(-1)!;
      const options = { key, bubbles: true, composed: true, cancelable: true, ctrlKey: parts.includes("Control"),
        metaKey: parts.includes("Meta"), altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift") };
      const accepted = target.dispatchEvent(new KeyboardEvent("keydown", options));
      if (accepted && (key === "Enter" || key === " ") && (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement))
        target.click();
      else if (accepted && key === "Enter" && (target instanceof HTMLTextAreaElement || target.isContentEditable))
        insert("\n", false);
      else if (accepted && key.toLowerCase() === "a" && (options.ctrlKey || options.metaKey) && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement))
        target.select();
      else if (accepted && ["Backspace", "Delete"].includes(key) && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        const start = target.selectionStart;
        const end = target.selectionEnd;
        if (start !== null && end !== null) {
          target.setSelectionRange(start === end && key === "Backspace" ? Math.max(0, start - 1) : start,
            start === end && key === "Delete" ? Math.min(target.value.length, end + 1) : end);
          insert("", false);
        }
      } else if (accepted && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(key) && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        const start = target.selectionStart;
        if (start !== null) {
          const position = key === "Home" ? 0 : key === "End" ? target.value.length : Math.max(0, Math.min(target.value.length, start + (key === "ArrowLeft" ? -1 : 1)));
          target.setSelectionRange(options.shiftKey ? start : position, position);
        }
      } else if (accepted && key === "Tab") {
        const focusable = scan(document).elements.filter(element => element instanceof HTMLElement && element.tabIndex >= 0 && visible(element) && !element.matches(":disabled"));
        const index = focusable.indexOf(target);
        (focusable[(index + (options.shiftKey ? -1 : 1) + focusable.length) % focusable.length] as HTMLElement | undefined)?.focus();
      }
      else if (accepted && key.length === 1 && !options.ctrlKey && !options.metaKey && !options.altKey)
        insert(key, false);
      target.dispatchEvent(new KeyboardEvent("keyup", options));
      break;
    }
    case "scroll":
      if (locator)
        target.scrollBy({ left: command.x ?? 0, top: command.y ?? 0, behavior: "instant" });
      else window.scrollBy({ left: command.x ?? 0, top: command.y ?? 0, behavior: "instant" });
      break;
    case "hover":
      target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true, pointerType: "mouse" }));
      target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true }));
      target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      break;
    default: throw new Error("Unknown page action.");
  }
  return { ok: true, status: "acted" };
}
