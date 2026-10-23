/**
 * 极小的测试断言层：让测试只依赖 node:test + node:assert，不再需要 bun:test。
 *
 * 只实现本项目实际用到的断言，保持 API 形状与之前一致（describe / it / expect）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

export { describe, it };

function fail(message: string): never {
  assert.fail(message);
}

class Expectation {
  constructor(
    private readonly actual: unknown,
    private readonly negated = false,
  ) {}

  get not(): Expectation {
    return new Expectation(this.actual, !this.negated);
  }

  private check(pass: boolean, describe: () => string): void {
    if (this.negated) {
      if (pass) fail(`not ${describe()}`);
      return;
    }
    if (!pass) fail(describe());
  }

  toBe(expected: unknown): void {
    this.check(
      Object.is(this.actual, expected),
      () => `expected ${JSON.stringify(this.actual)} to be ${JSON.stringify(expected)}`,
    );
  }

  toEqual(expected: unknown): void {
    let equal = true;
    try {
      assert.deepEqual(this.actual, expected);
    } catch {
      equal = false;
    }
    this.check(equal, () => `expected ${JSON.stringify(this.actual)} to equal ${JSON.stringify(expected)}`);
  }

  toContain(expected: string): void {
    const actual = typeof this.actual === "string" ? this.actual : String(this.actual);
    this.check(actual.includes(expected), () => `expected value to contain ${JSON.stringify(expected)}\n--- actual ---\n${actual}`);
  }

  toBeString(): void {
    this.check(typeof this.actual === "string", () => `expected ${JSON.stringify(this.actual)} to be a string`);
  }

  toBeUndefined(): void {
    this.check(this.actual === undefined, () => `expected ${JSON.stringify(this.actual)} to be undefined`);
  }

  toBeNull(): void {
    this.check(this.actual === null, () => `expected ${JSON.stringify(this.actual)} to be null`);
  }

  toHaveLength(length: number): void {
    const actualLength =
      typeof this.actual === "string" || Array.isArray(this.actual)
        ? this.actual.length
        : undefined;
    this.check(actualLength === length, () => `expected length ${length}, got ${actualLength}`);
  }

  toBeGreaterThan(value: number): void {
    this.check(
      typeof this.actual === "number" && this.actual > value,
      () => `expected ${String(this.actual)} > ${value}`,
    );
  }

  rejects = {
    toThrow: async (pattern?: RegExp): Promise<void> => {
      const promise = this.actual as Promise<unknown>;
      let thrown: unknown;
      let didThrow = false;
      try {
        await promise;
      } catch (error) {
        didThrow = true;
        thrown = error;
      }
      if (!didThrow) fail("expected promise to reject, but it resolved");
      if (pattern) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        if (!pattern.test(message)) fail(`expected rejection ${JSON.stringify(message)} to match ${pattern}`);
      }
    },
  };
}

export function expect(actual: unknown): Expectation {
  return new Expectation(actual);
}
