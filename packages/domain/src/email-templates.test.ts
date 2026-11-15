import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_TEMPLATE, formatFromAddress, parseTemplateDefinition, renderEmailTemplate } from "./email-templates";

describe("email templates", () => {
  it("only accepts whitelisted, declared variables", () => {
    expect(() => parseTemplateDefinition({ subject: "Hi {{password}}", body: "", allowedVariables: ["password"] })).toThrow("template_variable_not_allowed");
    expect(() => parseTemplateDefinition({ subject: "Hi {{title}}", body: "", allowedVariables: [] })).toThrow("template_variable_not_allowed");
    expect(() => parseTemplateDefinition({ subject: "a\r\nBcc: x", body: "", allowedVariables: [] })).toThrow("invalid_template_subject");
    expect(parseTemplateDefinition({ subject: "Hi {{ title }}", body: "{{body}}", allowedVariables: ["title", "body"] }).allowedVariables).toEqual(["title", "body"]);
  });

  it("escapes values in HTML and never lets them inject markdown or markup", () => {
    const rendered = renderEmailTemplate(
      { subject: "{{title}}", body: "Hello {{body}}\n\n[Open]({{link}})", allowedVariables: ["title", "body", "link"] },
      { title: "Line\r\nBcc: evil@x", body: "<script>x</script> [click](https://evil.example) **b**", link: "javascript:alert(1)" },
      { organizationName: "Org & Co", unsubscribeUrl: "https://app.example/unsub?t=a&b" }
    );
    expect(rendered.subject).toBe("Line Bcc: evil@x");
    expect(rendered.html).toContain("&lt;script&gt;x&lt;/script&gt; [click](https://evil.example) **b**");
    expect(rendered.html).not.toContain('href="https://evil.example"');
    expect(rendered.html).toContain('<a href="#">Open</a>');
    expect(rendered.html).toContain("Org &amp; Co");
    expect(rendered.html).toContain('href="https://app.example/unsub?t=a&amp;b"');
    expect(rendered.text).toContain("Unsubscribe: https://app.example/unsub?t=a&b");
  });

  it("uses safe variable link targets and requires every placeholder value", () => {
    const rendered = renderEmailTemplate(DEFAULT_NOTIFICATION_TEMPLATE, { title: "T", body: "B", link: "https://app.example/x" }, { organizationName: "O" });
    expect(rendered.html).toContain('<a href="https://app.example/x" rel="nofollow noopener noreferrer">Open</a>');
    expect(() => renderEmailTemplate(DEFAULT_NOTIFICATION_TEMPLATE, { title: "T" }, { organizationName: "O" })).toThrow("missing_template_variable");
  });

  it("formats sender addresses without header injection", () => {
    expect(formatFromAddress('Acme "Live"\r\n', "events@acme.example")).toBe('"Acme Live" <events@acme.example>');
  });
});
