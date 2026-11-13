import { beforeEach, expect, it, vi } from "vitest";
import { getDataforseoContext } from "./context";
import { runWithDataforseoAccountContext } from "./accountContext";

const settings = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock(
  "@/server/features/settings/services/DataforseoSettingsService",
  () => ({
    resolveEffectiveDataforseoConfig: settings.resolve,
  }),
);

beforeEach(() => {
  settings.resolve.mockReset();
});

it("account resolution failure prevents collection using another account", async () => {
  const failure = new Error("Settings storage unavailable");
  settings.resolve.mockRejectedValue(failure);
  const collect = vi.fn(async () => undefined);
  await expect(
    runWithDataforseoAccountContext(
      { organizationId: "org", projectId: "project" },
      collect,
    ),
  ).rejects.toBe(failure);
  expect(collect).not.toHaveBeenCalled();
});

it("account resolution binds project credentials only within collection", async () => {
  const previous = getDataforseoContext();
  settings.resolve.mockResolvedValue({
    login: "project-login",
    password: "test-password",
  });
  const result = await runWithDataforseoAccountContext(
    { organizationId: "org", projectId: "project" },
    async () => getDataforseoContext(),
  );
  expect(settings.resolve).toHaveBeenCalledWith({
    organizationId: "org",
    projectId: "project",
  });
  expect(result).toEqual({
    organizationId: "org",
    projectId: "project",
    login: "project-login",
    password: "test-password",
  });
  expect(getDataforseoContext()).toBe(previous);
});
