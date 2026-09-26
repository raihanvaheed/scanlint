// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldValue, isMaskable, MASK } from "./field-value";

afterEach(cleanup);

const BINARY_VRS = ["OB", "OW", "OF", "OD", "OL", "OV", "UN"];

type Props = Partial<Parameters<typeof FieldValue>[0]>;

function renderValue(props: Props = {}) {
  return render(
    <FieldValue name="Patient's Name" vr="PN" value="DOE^JANE" flagged revealed={false} onToggle={vi.fn()} {...props} />,
  );
}

// Holds the reveal state the way the views do, so a click can be followed through.
function Stateful(props: Props) {
  const [revealed, setRevealed] = useState(false);
  return (
    <FieldValue
      name="Patient's Name"
      vr="PN"
      value="DOE^JANE"
      flagged
      {...props}
      revealed={revealed}
      onToggle={() => setRevealed((r) => !r)}
    />
  );
}

describe("masking", () => {
  it("is exactly eight dots", () => {
    expect(MASK).toBe("●●●●●●●●");
    expect(MASK.length).toBe(8);
  });

  it.each([
    ["3 characters", "Bob"],
    ["60 characters", "A".repeat(60)],
  ])("masks a flagged value of %s to exactly eight dots, so the length is not leaked", (_label, value) => {
    renderValue({ value });

    expect(screen.getByRole("img", { name: "hidden value" }).textContent).toBe("●●●●●●●●");
    expect(screen.queryByText(value)).toBeNull();
    expect(document.body.textContent).not.toContain(value);
  });

  it("reveals the real value and re-masks it on hide", async () => {
    const user = userEvent.setup();
    render(<Stateful />);
    expect(screen.queryByText("DOE^JANE")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reveal Patient's Name" }));
    expect(screen.getByText("DOE^JANE")).toBeTruthy();
    expect(screen.queryByRole("img", { name: "hidden value" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hide Patient's Name" }));
    expect(screen.queryByText("DOE^JANE")).toBeNull();
    expect(screen.getByRole("img", { name: "hidden value" }).textContent).toBe(MASK);
  });

  it("puts the field's name in the control's accessible name, so the buttons are not all the same", () => {
    renderValue({ name: "(0029,0010)" });
    expect(screen.getByRole("button", { name: "Reveal (0029,0010)" })).toBeTruthy();

    cleanup();
    renderValue({ name: "(0029,0010)", revealed: true });
    expect(screen.getByRole("button", { name: "Hide (0029,0010)" })).toBeTruthy();
  });

  it("calls onToggle when the control is used", async () => {
    const onToggle = vi.fn();
    renderValue({ onToggle });
    await userEvent.setup().click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("never masks an unflagged value, and gives it no control", () => {
    renderValue({ flagged: false, revealed: false });

    expect(screen.getByText("DOE^JANE")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("an empty value", () => {
  it.each([false, true])("shows (empty), never dots, and has nothing to reveal (revealed: %s)", (revealed) => {
    renderValue({ value: "", revealed });

    expect(screen.getByText("(empty)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("●");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("a value that is not text", () => {
  it.each(BINARY_VRS)("shows %s as its length, never its bytes, masked or revealed", (vr) => {
    for (const revealed of [false, true]) {
      cleanup();
      renderValue({ vr, value: "SECRET-BYTES", length: 1234, revealed });

      expect(screen.getByText("<binary, 1,234 bytes>")).toBeTruthy();
      expect(document.body.textContent).not.toContain("SECRET-BYTES");
      expect(document.body.textContent).not.toContain("●");
      expect(screen.queryByRole("button")).toBeNull();
    }
  });

  it("separates thousands, and says byte in the singular", () => {
    renderValue({ vr: "OW", value: undefined, length: 131072 });
    expect(screen.getByText("<binary, 131,072 bytes>")).toBeTruthy();

    cleanup();
    renderValue({ vr: "OB", value: undefined, length: 1 });
    expect(screen.getByText("<binary, 1 byte>")).toBeTruthy();

    cleanup();
    renderValue({ vr: "OB", value: undefined, length: 0 });
    expect(screen.getByText("<binary, 0 bytes>")).toBeTruthy();
  });

  it("says the length is not stated, rather than inventing one, when there is none", () => {
    renderValue({ vr: "OB", value: undefined, length: undefined });
    expect(screen.getByText("<binary, length not stated>")).toBeTruthy();
  });

  it("shows (sequence) for a sequence and (not shown) for a value the walker does not read", () => {
    renderValue({ vr: "SQ", value: undefined });
    expect(screen.getByText("(sequence)")).toBeTruthy();

    cleanup();
    renderValue({ vr: "US", value: undefined });
    expect(screen.getByText("(not shown)")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("isMaskable", () => {
  it("is true only for a non-empty text value", () => {
    expect(isMaskable({ vr: "PN", value: "x" })).toBe(true);
    expect(isMaskable({ vr: "PN", value: "" })).toBe(false);
    expect(isMaskable({ vr: "PN" })).toBe(false);
    expect(isMaskable({ vr: "SQ" })).toBe(false);
    for (const vr of BINARY_VRS) expect(isMaskable({ vr, value: "x" })).toBe(false);
  });
});
