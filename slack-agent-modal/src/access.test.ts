import { test } from "node:test";
import assert from "node:assert/strict";
import { EMAIL_CACHE_MS, createAccessCheck, memberEmail, parseAllowlist } from "./access.js";

test("memberEmail: only a live human from the home team or org counts", () => {
  const profile = { email: "alex@example.com" };
  const home = { teamId: "T1", enterpriseId: "E1" };
  assert.equal(memberEmail({ team_id: "T1", profile }, home), "alex@example.com");
  assert.equal(memberEmail({ team_id: "T2", enterprise_user: { enterprise_id: "E1" }, profile }, home), "alex@example.com");
  // A Slack Connect user from another org, whose admin chose the email.
  assert.equal(memberEmail({ team_id: "T9", enterprise_user: { enterprise_id: "E9" }, profile }, home), undefined);
  assert.equal(memberEmail({ team_id: "T9", profile }, { teamId: "T1" }), undefined);
  assert.equal(memberEmail({ team_id: "T1", deleted: true, profile }, home), undefined);
  assert.equal(memberEmail({ team_id: "T1", is_bot: true, profile }, home), undefined);
  assert.equal(memberEmail(undefined, home), undefined);
  // An unknown home never matches a user with no team.
  assert.equal(memberEmail({ profile }, {}), undefined);
});

test("a cached email expires, so a changed email loses access", async () => {
  let t = 0;
  let email = "alex@example.com";
  const isAllowed = createAccessCheck({
    allowlist: parseAllowlist("alex@example.com"),
    lookupEmail: async () => email,
    now: () => t,
  });
  assert.equal(await isAllowed("U9"), true);
  email = "other@example.com";
  t = EMAIL_CACHE_MS - 1;
  assert.equal(await isAllowed("U9"), true);
  t = EMAIL_CACHE_MS;
  assert.equal(await isAllowed("U9"), false);
});

test("parseAllowlist: splits on commas and whitespace, sorting IDs from emails", () => {
  const { userIds, emails } = parseAllowlist(" U1, u2\nAlex@Example.com ,, ");
  assert.deepEqual([...userIds], ["U1", "U2"]);
  assert.deepEqual([...emails], ["alex@example.com"]);
});

test("allows a listed user ID without looking up an email", async () => {
  const lookups: string[] = [];
  const isAllowed = createAccessCheck({
    allowlist: parseAllowlist("U1, alex@example.com"),
    lookupEmail: async (id) => (lookups.push(id), undefined),
  });
  assert.equal(await isAllowed("U1"), true);
  assert.deepEqual(lookups, []);
});

test("allows a user whose email is listed, case-insensitively, and caches the lookup", async () => {
  const lookups: string[] = [];
  const isAllowed = createAccessCheck({
    allowlist: parseAllowlist("alex@example.com"),
    lookupEmail: async (id) => (lookups.push(id), "Alex@Example.com"),
  });
  assert.equal(await isAllowed("U9"), true);
  assert.equal(await isAllowed("U9"), true);
  assert.deepEqual(lookups, ["U9"]);
});

test("skips the lookup when the list has no emails", async () => {
  const isAllowed = createAccessCheck({
    allowlist: parseAllowlist("U1"),
    lookupEmail: async () => assert.fail("should not look up"),
  });
  assert.equal(await isAllowed("U2"), false);
});

test("fails closed: empty list, missing user, no email, failed lookup", async () => {
  const log = () => {};
  assert.equal(await createAccessCheck({ allowlist: parseAllowlist(""), lookupEmail: async () => "a@b.c", log })("U1"), false);

  const listed = parseAllowlist("a@b.c");
  assert.equal(await createAccessCheck({ allowlist: listed, lookupEmail: async () => "a@b.c", log })(undefined), false);
  assert.equal(await createAccessCheck({ allowlist: listed, lookupEmail: async () => undefined, log })("U1"), false);

  // A failed lookup isn't cached, so the next message retries.
  let calls = 0;
  const flaky = createAccessCheck({
    allowlist: listed,
    lookupEmail: async () => {
      if (++calls === 1) throw new Error("ratelimited");
      return "a@b.c";
    },
    log,
  });
  assert.equal(await flaky("U1"), false);
  assert.equal(await flaky("U1"), true);
});
