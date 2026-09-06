// @vitest-environment happy-dom
/**
 * The shared search box (owner review B4): one field, standard chrome, three call sites.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchInput } from "./search-input.tsx";

afterEach(cleanup);

describe("SearchInput", () => {
  it("wears the standard input chrome rather than a hand-painted panel", () => {
    const { container } = render(
      <SearchInput value="" onValueChange={vi.fn()} placeholder="Search albums…" />,
    );
    const field = container.querySelector('[data-slot="input"]');
    const classes = (field?.className ?? "").split(/\s+/);
    // The standard field's own border and fill, untouched...
    expect(classes).toContain("border-input");
    expect(classes).toContain("dark:bg-input/30");
    // ...and none of the overrides the three hand-rolled copies used to apply.
    expect(classes).not.toContain("border-0");
    expect(classes).not.toContain("focus-visible:ring-0");
    expect(classes).not.toContain("shadow-none");
    expect(container.querySelector('[data-slot="search-input"]')?.className).not.toContain(
      "bg-surface-1",
    );
  });

  it("submits on Enter with the value the field holds", () => {
    const onSubmit = vi.fn();
    render(
      <SearchInput value="chvrches" onValueChange={vi.fn()} onSubmit={onSubmit} label="Search" />,
    );
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("chvrches");
  });

  it("reports every keystroke, and nothing else", () => {
    const onValueChange = vi.fn();
    const onSubmit = vi.fn();
    render(<SearchInput value="" onValueChange={onValueChange} onSubmit={onSubmit} label="S" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ch" } });
    expect(onValueChange).toHaveBeenCalledWith("ch");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("offers a clear button only once there is something to clear", () => {
    const onValueChange = vi.fn();
    const onSubmit = vi.fn();
    const { rerender } = render(
      <SearchInput value="" onValueChange={onValueChange} onSubmit={onSubmit} label="S" />,
    );
    expect(screen.queryByRole("button", { name: "Clear the search" })).toBeNull();

    rerender(
      <SearchInput value="ch" onValueChange={onValueChange} onSubmit={onSubmit} label="S" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    expect(onValueChange).toHaveBeenCalledWith("");
    // Submitted with the new value, not with the stale state the caller still holds.
    expect(onSubmit).toHaveBeenCalledWith("");
  });
});
