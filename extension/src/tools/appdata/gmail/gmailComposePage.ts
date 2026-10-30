export type GmailComposeResult = { kind: "filled"; attached: { name: string; shown: boolean }[] }
  | { kind: "no_reply_link" } | { kind: "no_compose" } | { kind: "no_attach_button" } | { kind: "no_file_input" };

// Runs in the Gmail tab (isolated world). It only opens a reply, types into the message body and hands files to the
// compose window's file input: it never dispatches a key event and never touches the send button.
export async function gmailComposePage(reply: "reply" | "replyAll" | null, body: string | null, files: { name: string; data: string }[]): Promise<GmailComposeResult> {
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
  if (reply) {
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
