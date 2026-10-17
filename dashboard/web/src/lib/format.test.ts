import { expect, it } from "vitest"
import { levelOf } from "@/lib/format"

it("uses each Machine’s thresholds and classifies the rounded reading", () => {
  expect(levelOf(69.6, { high: 60, hot: 70 })).toBe("full")
  expect(levelOf(69.4, { high: 60, hot: 70 })).toBe("high")
  expect(levelOf(95, { high: 96, hot: 99 })).toBe("ok")
  expect(levelOf(100, undefined)).toBe("ok")
})
