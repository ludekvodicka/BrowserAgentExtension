export type GmailComposeResult = { kind: "filled"; attached: { name: string; shown: boolean }[] }
  | { kind: "no_reply_link" } | { kind: "no_message" } | { kind: "no_message_reply" } | { kind: "other_recipient" }
  | { kind: "no_compose" } | { kind: "no_attach_button" } | { kind: "no_file_input" };

// Runs in the Gmail tab (isolated world). It only opens a reply, types into the message body and hands files to the
// compose window's file input: it never dispatches a key event and never touches the send button.
// With `from`, it replies to the latest message of that sender through the message's own reply button.
export async function gmailComposePage(reply: "reply" | "replyAll" | null, body: string | null, files: { name: string; data: string }[],
  from: string | null = null): Promise<GmailComposeResult> {
  const wait = async <T>(find: () => T | null | undefined, ms: number): Promise<T | null> => {
    const end = Date.now() + ms;
    for (;;) {
      const found = find();
      if (found || Date.now() >= end)
        return found ?? null;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const press = (element: Element) => {
    for (const type of ["mousedown", "mouseup", "click"])
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  };
  const editors = () => [...document.querySelectorAll<HTMLElement>("div[contenteditable='true'][role='textbox']")].filter(element => element.checkVisibility());
  let editor: HTMLElement | null;
  if (reply && from) {
    // Each message of the open conversation is a list item whose first address element is its sender.
    const target = from.toLowerCase();
    const message = () => [...document.querySelectorAll<HTMLElement>("[role='main'] [role='listitem']")]
      .filter(element => element.querySelector("[email]")?.getAttribute("email")?.toLowerCase() === target).at(-1);
    // A longer conversation hides its middle messages behind a count bubble (div.adv, its button span.adx).
    const bubble = [...document.querySelectorAll<HTMLElement>("[role='main'] div.adv [role='button']")].find(element => element.checkVisibility());
    if (!message() && bubble)
      press(bubble);
    const item = message() ?? (bubble ? await wait(message, 3000) : undefined);
    if (!item)
      return { kind: "no_message" };
    // The message's reply button (a plain <button>) carries the same localized label as the reply link below the
    // conversation; that link may be hidden by an open reply, so its text is read regardless of visibility.
    // button.DILLkc is the reply button's class when no such link exists.
    const label = document.querySelector<HTMLElement>("span.ams.bkH")?.textContent?.trim();
    const button = () => [...item.querySelectorAll<HTMLElement>("button, [role='button']")].filter(element => element.checkVisibility())
      .find(element => label && (element.getAttribute("aria-label") === label || element.getAttribute("data-tooltip") === label) || element.matches("button.DILLkc"));
    // A collapsed message expands on a press of its header row (div.kv; div.kQ when hidden behind the count).
    if (!button())
      press(item.querySelector<HTMLElement>(".kv, .kQ") ?? item.querySelector("[email]")!.parentElement!);
    const found = await wait(button, 3000);
    if (!found)
      return { kind: "no_message_reply" };
    const before = new Set(editors());
    press(found);
    editor = await wait(() => editors().find(element => !before.has(element)), 4000);
    // The reply's recipients are chips (div.afV, address in data-hovercard-id) above its body, hidden while collapsed;
    // the nearest ancestor of the body that holds chips is that reply's own recipient area.
    // Gmail adds the chips a moment after the body appears, so they are awaited.
    const recipients = () => {
      let scope: HTMLElement | null = editor;
      while (scope && !scope.querySelector("div.afV"))
        scope = scope.parentElement;
      return [...scope?.querySelectorAll("div.afV") ?? []].map(chip => (chip.getAttribute("data-hovercard-id") ?? chip.getAttribute("email") ?? "").toLowerCase());
    };
    if (editor && !await wait(() => recipients().includes(target) || null, 3000))
      return { kind: "other_recipient" };
  } else if (reply) {
    // The reply links below the open conversation keep these class names in every display language.
    const link = [...document.querySelectorAll(reply === "reply" ? "span.ams.bkH" : "span.ams.bkI")].filter(element => element.checkVisibility()).at(-1);
    if (!link)
      return { kind: "no_reply_link" };
    const before = new Set(editors());
    press(link);
    editor = await wait(() => editors().find(element => !before.has(element)), 4000);
  } else editor = await wait(() => editors()[0], 8000);
  if (!editor)
    return { kind: "no_compose" };
  if (body) {
    editor.focus();
    const range = document.createRange();
    range.setStart(editor, 0);
    range.collapse(true);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    body.split("\n").forEach((line, index) => {
      if (index)
        document.execCommand("insertLineBreak");
      if (line)
        document.execCommand("insertText", false, line);
    });
  }
  if (!files.length)
    return { kind: "filled", attached: [] };
  // Each compose window has its own attach button with command="Files"; pressing it makes Gmail create the file input it reads.
  let root: HTMLElement | null = editor;
  while (root && !root.querySelector("div[command='Files']"))
    root = root.parentElement;
  const button = root?.querySelector("div[command='Files']");
  if (!root || !button)
    return { kind: "no_attach_button" };
  const inputsBefore = new Set(document.querySelectorAll("input[type='file']"));
  press(button);
  const input = await wait(() => [...document.querySelectorAll<HTMLInputElement>("input[type='file']")].find(element => !inputsBefore.has(element)), 2000)
    ?? [...document.querySelectorAll<HTMLInputElement>("input[type='file']")].at(-1);
  if (!input)
    return { kind: "no_file_input" };
  const transfer = new DataTransfer();
  for (const file of files) {
    const binary = atob(file.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
      bytes[i] = binary.charCodeAt(i);
    transfer.items.add(new File([bytes], file.name));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  const compose = root;
  await wait(() => files.every(file => compose.innerText.includes(file.name)) || null, 6000);
  return { kind: "filled", attached: files.map(file => ({ name: file.name, shown: compose.innerText.includes(file.name) })) };
}
