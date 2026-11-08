export const sanitizeElementText = (value: unknown): string =>
  (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .slice(0, 5000);
