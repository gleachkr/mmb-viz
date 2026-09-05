import { describe, expect, it } from "vitest";
import { formatLocation, parseLocation, type Location } from "../src/ui/state";

describe("location hash", () => {
  it("round-trips every field", () => {
    const loc: Location = { example: "peano.mmb", at: 0x40, view: "debug", stmt: "ax_mp", step: 17 };
    const hash = formatLocation(loc);
    expect(hash).toBe("#example=peano.mmb&at=0x40&view=debug&stmt=ax_mp&step=17");
    expect(parseLocation(hash)).toEqual(loc);
  });

  it("omits absent fields and the hexdump view", () => {
    expect(formatLocation({})).toBe("");
    expect(formatLocation({ example: "tutorial.mmb", view: "hex" })).toBe("#example=tutorial.mmb");
    expect(parseLocation("#example=tutorial.mmb")).toEqual({ example: "tutorial.mmb" });
    expect(parseLocation("")).toEqual({});
  });

  it("accepts decimal offsets and index-named statements, and drops malformed values", () => {
    expect(parseLocation("#at=64&stmt=%2312&step=3")).toEqual({ at: 64, stmt: "#12", step: 3 });
    expect(parseLocation("#at=zz&step=-1&view=other")).toEqual({});
  });
});
