import { describe, expect, it } from "vitest";
import { looksLikePersonName } from "./name-plausibility.js";

describe("looksLikePersonName", () => {
  it("rejects null and empty names", () => {
    expect(looksLikePersonName(null)).toBe(false);
    expect(looksLikePersonName(undefined)).toBe(false);
    expect(looksLikePersonName("")).toBe(false);
    expect(looksLikePersonName("   ")).toBe(false);
  });

  // Real Day 5 examples that extracted "correctly" per their strategy's own
  // logic but aren't a person.
  it("rejects a short all-caps outlet name (RT)", () => {
    expect(looksLikePersonName("RT")).toBe(false);
  });

  it("rejects a company self-attribution with a dba clause (Maplebear Inc. dba Instacart)", () => {
    expect(looksLikePersonName("Maplebear Inc. dba Instacart")).toBe(false);
  });

  it("rejects a byline-bleed artifact with a trailing date fragment (MarketBeat August 7)", () => {
    expect(looksLikePersonName("MarketBeat August 7")).toBe(false);
  });

  it("accepts an ordinary two-word name", () => {
    expect(looksLikePersonName("Jane Doe")).toBe(true);
  });

  it("accepts an ordinary three-word name", () => {
    expect(looksLikePersonName("Alex Maria Rivera")).toBe(true);
  });

  it("accepts a hyphenated and apostrophe'd name", () => {
    expect(looksLikePersonName("Sam O'Brien-Lund")).toBe(true);
  });

  it("rejects a single-token name", () => {
    expect(looksLikePersonName("Cher")).toBe(false);
  });

  it("rejects more than four tokens", () => {
    expect(looksLikePersonName("This Is Not A Real Name")).toBe(false);
  });

  it("rejects an all-uppercase multi-word string", () => {
    expect(looksLikePersonName("AP NEWS")).toBe(false);
  });

  it("rejects names containing common company-suffix words", () => {
    expect(looksLikePersonName("Callaway Golf Company")).toBe(false);
    expect(looksLikePersonName("Acme LLC")).toBe(false);
    expect(looksLikePersonName("Staff Writer")).toBe(false);
    expect(looksLikePersonName("News Editorial Team")).toBe(false);
  });
});
