export type GmailMessage = { from: string; date: string; recipients: string[]; body: string; attachments: { id: string | null; name: string; size: string }[] };
export type GmailThreadPageResult = { kind: "extension_error" } | { kind: "thread"; subject: string; messages: GmailMessage[] };

// Runs as an isolated script: Gmail's Trusted Types policy blocks DOMParser in its main world.
// Reads the thread's print view, which lists every message expanded, and turns it into plain text.
export async function gmailThreadPage(user: string, ik: string, threadId: string): Promise<GmailThreadPageResult> {
  const blocks = ["ADDRESS", "BLOCKQUOTE", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "OL", "P", "PRE", "TABLE", "TR", "UL"];
  const text = (node: Node): string => {
    if (node.nodeType === 3)
      return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== 1)
      return "";
    const element = node as Element;
    if (["HEAD", "SCRIPT", "STYLE", "TITLE"].includes(element.tagName))
      return "";
    if (element.tagName === "BR")
      return "\n";
    let inner = [...element.childNodes].map(text).join("");
    const href = element.tagName === "A" ? element.getAttribute("href") : null;
    if (href && /^https?:/.test(href) && inner.trim() !== href)
      inner += ` <${href}>`;
    if (element.tagName === "LI")
      inner = `- ${inner}`;
    return blocks.includes(element.tagName) ? `\n${inner}\n` : element.tagName === "TD" ? `${inner} ` : inner;
  };
  const clean = (value: string) => value.split("\n").map(line => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  try {
    if (location.origin !== "https://mail.google.com" || !/^\d{1,3}$/.test(user) || !/^[0-9a-z]{1,40}$/i.test(ik) || !/^thread-(f:|a:r-?)\d{1,30}$/.test(threadId))
      return { kind: "extension_error" };
    const response = await fetch(`/mail/u/${user}/?ik=${ik}&view=pt&search=all&permthid=${encodeURIComponent(threadId)}`, { redirect: "error" });
    if (!response.ok)
      return { kind: "extension_error" };
    const page = new DOMParser().parseFromString(await response.text(), "text/html");
    const messages = [...page.querySelectorAll("table.message")].map(message => {
      const [header, recipients, content] = [...message.querySelectorAll<HTMLTableRowElement>(":scope > tbody > tr")];
      const attachments = [...message.querySelectorAll("a[href*='view=att']")].map(link => link.closest("tr")!).filter((row, index, rows) => rows.indexOf(row) === index).map(row => {
        const name = clean(text(row.querySelector("b") ?? row));
        const query = new URLSearchParams((row.querySelector("a[href*='view=att']")!.getAttribute("href") ?? "").split("?")[1] ?? "");
        const [th, attid] = [query.get("th"), query.get("attid")];
        return { id: th && attid ? `${th}:${attid}` : null, name, size: clean(text(row)).replace(name, "").trim() };
      // Gmail can list one attachment in two rows (seen with a text file and its preview).
      }).filter((attachment, index, all) => attachment.id === null || all.findIndex(other => other.id === attachment.id) === index);
      const body = content?.querySelector("td > table td > div");
      return { from: clean(text(header?.cells[0] ?? message)), date: clean(text(header?.cells[1] ?? message)),
        recipients: [...(recipients?.querySelectorAll(".recipient > div") ?? [])].map(line => clean(text(line))),
        body: body ? clean(text(body)) : "", attachments };
    });
    return { kind: "thread", subject: clean(text(page.querySelector(".maincontent font[size='+1']") ?? page.createElement("i"))), messages };
  } catch {
    return { kind: "extension_error" };
  }
}
