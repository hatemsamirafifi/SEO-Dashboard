import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  grants: vi.fn(),
  deleteGrant: vi.fn(),
  hasConsent: vi.fn(),
  listProperties: vi.fn(),
  getUserInfoEmail: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  inUse: vi.fn(),
}));
vi.mock("@/server/features/ga4/repositories/Ga4GrantRepository", () => ({
  Ga4GrantRepository: {
    listForUser: mocks.grants,
    deleteForUserAccount: mocks.deleteGrant,
    hasAnalyticsConsent: mocks.hasConsent,
  },
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: {
    getByProjectId: mocks.get,
    upsert: mocks.upsert,
    deleteByProjectId: mocks.remove,
    existsForConnectorAccount: mocks.inUse,
  },
}));
vi.mock("@/server/lib/ga4Client", () => ({
  createGa4Client: () => ({
    listProperties: mocks.listProperties,
    getUserInfoEmail: mocks.getUserInfoEmail,
  }),
  Ga4ApiError: class Ga4ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  Ga4TokenError: class Ga4TokenError extends Error {},
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/seo-data/cost-tracker", () => ({
  recordFreeProviderCall: () => {},
}));

describe("Ga4Service boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.hasConsent.mockImplementation((scope) => scope === "analytics");
    mocks.grants.mockResolvedValue([
      { accountId: "a", scope: "analytics" },
      { accountId: "old", scope: "openid" },
    ]);
  });
  it("lists and sets only properties verified against a scoped grant", async () => {
    mocks.listProperties.mockResolvedValue([
      { propertyId: "p", displayName: "Property", currencyCode: null },
    ]);
    mocks.upsert.mockResolvedValue({ propertyId: "p" });
    const { Ga4Service } = await import("./Ga4Service");
    await expect(Ga4Service.listPropertiesForUser("u")).resolves.toEqual([
      {
        accountId: "a",
        properties: [
          { propertyId: "p", displayName: "Property", currencyCode: null },
        ],
      },
    ]);
    await Ga4Service.setProperty({
      projectId: "p1",
      organizationId: "o1",
      userId: "u",
      accountId: "a",
      propertyId: "p",
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        organizationId: "o1",
        propertyDisplayName: "Property",
      }),
    );
  });
  it("keeps a grant that another project still uses during disconnect", async () => {
    mocks.get.mockResolvedValue({ connectedByUserId: "u", ga4AccountId: "a" });
    mocks.inUse.mockResolvedValue(true);
    const { Ga4Service } = await import("./Ga4Service");
    await Ga4Service.disconnect({
      projectId: "p1",
      organizationId: "o1",
      userId: "u",
    });
    expect(mocks.remove).toHaveBeenCalledWith("p1", "o1");
    expect(mocks.deleteGrant).not.toHaveBeenCalled();
  });
  it("listPropertiesForUserWithGrantStatus reports accounts with properties and grant validity", async () => {
    mocks.getUserInfoEmail.mockResolvedValue("test@example.com");
    mocks.listProperties.mockResolvedValue([
      {
        propertyId: "123",
        displayName: "Prop 1",
        accountDisplayName: "Acct 1",
      },
    ]);
    const { Ga4Service } = await import("./Ga4Service");
    const result = await Ga4Service.listPropertiesForUserWithGrantStatus("u");
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]).toEqual({
      accountId: "a",
      email: "test@example.com",
      requiresReconnect: false,
      propertiesUnavailable: false,
      properties: [
        {
          propertyId: "123",
          displayName: "Prop 1",
          accountDisplayName: "Acct 1",
        },
      ],
    });
  });
});
