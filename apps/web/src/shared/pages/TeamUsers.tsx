// The team page (#26) — the roster and the user lifecycle in one place:
// invite, rename, disable/enable, and the role grant/revoke verbs (whose
// server-side gates and approval flow landed with #23/#221).
//
// The page's three rules stay on the first screen because they are the ones
// operators keep rediscovering: creation never carries a privileged role (the
// approval gate is the only door to owner/admin/finance), disable signs the
// person out everywhere and blocks new sign-ins, and nothing is ever deleted —
// disable is the removal path and the audit trail keeps the rest. The owner's
// account is untouchable below the owner (server 403 owner_required) and the
// page says so where the action would fail.
//
// States are honest, never blank-by-accident — loading, no users.manage
// permission, an unreachable API, an empty roster, and every write failure
// mode say themselves in words (the adapter reports the failure mode — see
// users-client.ts).
import type { ReactElement } from "react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, Heading, Input, Paragraph } from "@ally/ui";

import {
  createUsersAdapters,
  INVITE_ROLES,
  STAFF_ROLES,
  type CreateFailure,
  type LifecycleFailure,
  type RosterStatus,
  type RoleChangeFailure,
  type RenameFailure,
  type UserRow,
} from "../lib/users-client.ts";
import { useSession } from "../lib/session.ts";

const usersAdapters = createUsersAdapters();

const CREATE_ERRORS: Record<Exclude<CreateFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage users.",
  invalid: "The invitation was rejected — check the email, name and roles.",
  exists: "An account with that email already exists.",
};

const RENAME_ERRORS: Record<Exclude<RenameFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage users.",
  not_found: "This account no longer exists — someone removed it while you were editing.",
  invalid: "The name was rejected — it must be 1–200 characters.",
};

const LIFECYCLE_ERRORS: Record<Exclude<LifecycleFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to manage users.",
  owner_required: "The owner's account can only be disabled or re-enabled by the owner.",
  self: "You cannot disable your own account while signed in.",
  not_found: "This account no longer exists.",
};

const ROLE_ERRORS: Record<Exclude<RoleChangeFailure, "unavailable">, string> = {
  forbidden: "Your account does not have permission to assign roles.",
  owner_approval_required:
    "Granting or revoking owner, admin or finance needs the owner's approval — only the owner can do it directly.",
  owner_approval_pending:
    "An approval request for this role change is already waiting for the owner.",
  not_found: "This account no longer exists.",
  invalid: "The role change was rejected.",
};

function failureMessage<T extends string>(
  catalog: Record<Exclude<T, "unavailable">, string>,
  reason: T,
): string {
  return reason === "unavailable"
    ? "The change could not be saved. Reload and try again."
    : catalog[reason as Exclude<T, "unavailable">];
}

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

const STATUS_FILTERS: { key: RosterStatus | "all"; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "disabled", label: "Disabled" },
  { key: "all", label: "All" },
];

export function TeamUsers(): ReactElement {
  const queryClient = useQueryClient();
  const { user: me } = useSession();
  const [statusFilter, setStatusFilter] = useState<RosterStatus | "all">("active");
  const [flash, setFlash] = useState<string | null>(null);

  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRoles, setCreateRoles] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [renameTarget, setRenameTarget] = useState<UserRow | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const [grantDraft, setGrantDraft] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const rosterQuery = useQuery({
    queryKey: ["team-users", statusFilter],
    queryFn: () =>
      usersAdapters.list(statusFilter === "all" ? undefined : statusFilter),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ["team-users"] });
  }

  function submitCreate(): void {
    setCreating(true);
    setCreateError(null);
    void (async () => {
      const result = await usersAdapters.create({
        email: createEmail,
        ...(createName.trim() === "" ? {} : { name: createName.trim() }),
        ...(createRoles.length === 0 ? {} : { roles: createRoles }),
      });
      setCreating(false);
      if (!result.ok) {
        setCreateError(failureMessage(CREATE_ERRORS, result.reason));
        return;
      }
      setFlash(
        result.data.inviteRequested
          ? `Account created for ${result.data.user.email} — a set-up link was emailed. The account cannot sign in until the password is set.`
          : `Account created for ${result.data.user.email}.`,
      );
      setCreateEmail("");
      setCreateName("");
      setCreateRoles([]);
      refresh();
    })();
  }

  function submitRename(): void {
    if (renameTarget === null) return;
    setRenameError(null);
    void (async () => {
      const result = await usersAdapters.rename(renameTarget.id, renameDraft.trim());
      if (!result.ok) {
        setRenameError(failureMessage(RENAME_ERRORS, result.reason));
        return;
      }
      setFlash(`Name updated to ${result.data.name}.`);
      setRenameTarget(null);
      refresh();
    })();
  }

  function setLifecycle(target: UserRow, verb: "disable" | "enable"): void {
    setRowError({});
    void (async () => {
      const result = verb === "disable" ? await usersAdapters.disable(target.id) : await usersAdapters.enable(target.id);
      if (!result.ok) {
        setRowError({ [target.id]: failureMessage(LIFECYCLE_ERRORS, result.reason) });
        return;
      }
      setFlash(
        verb === "disable"
          ? `${target.email} is disabled — sessions were signed out and new sign-ins are refused.`
          : `${target.email} is active again and can sign in.`,
      );
      refresh();
    })();
  }

  function grant(target: UserRow): void {
    const role = grantDraft[target.id];
    if (role === undefined || role === "") return;
    setRowError({});
    void (async () => {
      const result = await usersAdapters.grantRole(target.id, role);
      if (!result.ok) {
        setRowError({ [target.id]: failureMessage(ROLE_ERRORS, result.reason) });
        return;
      }
      setFlash(
        result.outcome === "pending_approval"
          ? `Role ${role} sent for the owner's approval — it applies when the owner approves.`
          : result.outcome === "already_held"
            ? `${target.email} already holds the ${role} role — nothing changed.`
            : `${target.email} now holds the ${role} role.`,
      );
      setGrantDraft((draft) => ({ ...draft, [target.id]: "" }));
      refresh();
    })();
  }

  function revoke(target: UserRow, role: string): void {
    setRowError({});
    void (async () => {
      const result = await usersAdapters.revokeRole(target.id, role);
      if (!result.ok) {
        setRowError({ [target.id]: failureMessage(ROLE_ERRORS, result.reason) });
        return;
      }
      setFlash(
        result.outcome === "already_absent"
          ? `${target.email} did not hold the ${role} role — nothing changed.`
          : `${target.email} no longer holds the ${role} role.`,
      );
      refresh();
    })();
  }

  const roster = rosterQuery.data?.ok === true ? rosterQuery.data.data : undefined;
  const forbidden = rosterQuery.data?.ok === false && rosterQuery.data.reason === "forbidden";
  const unavailable = rosterQuery.data?.ok === false && rosterQuery.data.reason === "unavailable";

  return (
    <div className="w-full" data-page="team-users" data-testid="team-users-root">
      <Card>
        <Heading as="h2">Team</Heading>
        <Paragraph className="text-ink-soft">
          The roster of every account — staff and customer previews alike. Role changes ride the
          same approval gates as everywhere else; privileged roles (owner, admin, finance) need the
          owner, on the roster too.
        </Paragraph>
        <Paragraph className="mt-2 text-ink-soft">
          Creating a user emails a set-up link — the account cannot sign in until its password is
          set. Disabling signs the person out everywhere and blocks new sign-ins. Accounts are
          never deleted: disable is the removal path, and the audit log keeps the rest.
        </Paragraph>

        {flash !== null && (
          <Paragraph className="mt-3 text-ink" data-testid="team-users-flash">
            {flash}
          </Paragraph>
        )}

        {rosterQuery.isPending && <Paragraph className="mt-3" data-testid="team-users-loading">Loading the roster…</Paragraph>}
        {forbidden && (
          <Paragraph className="mt-3 text-ink-soft" data-testid="team-users-forbidden">
            Your account does not have permission to view the team roster.
          </Paragraph>
        )}
        {unavailable && (
          <Paragraph className="mt-3 text-ink-soft" data-testid="team-users-unavailable">
            The roster could not be loaded. Reload and try again.
          </Paragraph>
        )}

        {roster !== undefined && (
          <>
            <div className="mt-3 flex gap-2" role="group" aria-label="Roster status filter">
              {STATUS_FILTERS.map((filter) => (
                <Button
                  key={filter.key}
                  variant={statusFilter === filter.key ? "default" : "ghost"}
                  size="sm"
                  data-testid={`team-users-filter-${filter.key}`}
                  onClick={() => {
                    setStatusFilter(filter.key);
                  }}
                >
                  {filter.label}
                </Button>
              ))}
            </div>

            {roster.users.length === 0 ? (
              <Paragraph className="mt-3 text-ink-soft" data-testid="team-users-empty">
                {statusFilter === "disabled"
                  ? "No disabled accounts."
                  : "No accounts match this filter yet."}
              </Paragraph>
            ) : (
              <div className="mt-3 overflow-x-auto" data-testid="team-users-table">
                <table className="w-full border-collapse text-left text-ui-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Name</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Email</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Roles</th>
                      <th className="py-2 pr-4 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase">Status</th>
                      <th className="py-2 font-mono text-[length:var(--fs-meta)] font-medium tracking-[var(--ls-crumb)] text-ink-soft uppercase"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.users.map((row) => (
                      <tr key={row.id} className="border-b border-line align-top" data-testid="team-user-row">
                        <td className="py-2 pr-4">
                          {row.name}
                          {me !== null && me.id === row.id && (
                            <span className="ml-2 text-ink-soft" data-testid="team-user-you">(you)</span>
                          )}
                          {renameTarget?.id === row.id ? (
                            <div className="mt-2 rounded-card border border-line p-3" data-testid="team-rename-form">
                              <label className="text-ui-sm text-ink">
                                New name
                                <Input
                                  className="mt-1 block w-full"
                                  value={renameDraft}
                                  onChange={(e) => {
                                    setRenameDraft(e.target.value);
                                  }}
                                  data-testid="team-rename-input"
                                />
                              </label>
                              {renameError !== null && (
                                <Paragraph className="mt-2 text-err font-medium" data-testid="team-rename-error">
                                  {renameError}
                                </Paragraph>
                              )}
                              <div className="mt-2 flex gap-2">
                                <Button size="sm" data-testid="team-rename-save" onClick={submitRename}>
                                  Save name
                                </Button>
                                <Button variant="ghost" size="sm" data-testid="team-rename-cancel" onClick={() => {
              setRenameTarget(null);
            }}>
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </td>
                        <td className="py-2 pr-4 font-mono">{row.email}</td>
                        <td className="py-2 pr-4">
                          <span className="flex flex-wrap items-center gap-1" data-testid="team-user-roles">
                            {row.roles.length === 0 && <span className="text-ink-soft">—</span>}
                            {row.roles.map((role) => (
                              <span key={role} className="inline-flex items-center gap-1 rounded-control border border-line px-2 py-[2px] font-mono text-ui-sm">
                                {role}
                                <button
                                  type="button"
                                  aria-label={`Revoke ${role}`}
                                  className="text-ink-soft hover:text-err"
                                  data-testid={`team-revoke-${role}`}
                                  onClick={() => {
                                    revoke(row, role);
                                  }}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                          </span>
                          <span className="mt-2 flex items-center gap-2">
                            <select
                              aria-label={`Grant a role to ${row.email}`}
                              className="rounded-control border border-line bg-card p-[var(--pad-control)] text-ui text-ink"
                              value={grantDraft[row.id] ?? ""}
                              data-testid={`team-grant-select-${row.id}`}
                              onChange={(e) => {
                                setGrantDraft((draft) => ({ ...draft, [row.id]: e.target.value }));
                              }}
                            >
                              <option value="">Grant a role…</option>
                              {STAFF_ROLES.filter((role) => !row.roles.includes(role)).map((role) => (
                                <option key={role} value={role}>
                                  {role}
                                </option>
                              ))}
                            </select>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={(grantDraft[row.id] ?? "") === ""}
                              data-testid={`team-grant-submit-${row.id}`}
                              onClick={() => {
                                grant(row);
                              }}
                            >
                              Grant
                            </Button>
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          {row.disabledAt === null ? (
                            <span className="font-medium text-brand" data-testid="team-user-active">Active</span>
                          ) : (
                            <span className="text-ink-soft" data-testid="team-user-disabled">
                              Disabled {formatDateTime(row.disabledAt)}
                            </span>
                          )}
                          {!row.emailVerified && (
                            <span className="block text-ink-soft">Email not verified</span>
                          )}
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="default"
                              size="sm"
                              data-testid={`team-rename-${row.id}`}
                              onClick={() => {
                                setRenameTarget(row);
                                setRenameDraft(row.name);
                                setRenameError(null);
                              }}
                            >
                              Rename
                            </Button>
                            {row.disabledAt === null ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                data-testid={`team-disable-${row.id}`}
                                onClick={() => {
                                  setLifecycle(row, "disable");
                                }}
                              >
                                Disable
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                data-testid={`team-enable-${row.id}`}
                                onClick={() => {
                                  setLifecycle(row, "enable");
                                }}
                              >
                                Enable
                              </Button>
                            )}
                          </div>
                          {rowError[row.id] !== undefined && (
                            <Paragraph className="mt-2 max-w-xs text-err font-medium" data-testid={`team-row-error-${row.id}`}>
                              {rowError[row.id]}
                            </Paragraph>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-4 rounded-card border border-line p-4" data-testid="team-create-form">
              <Heading as="h3">Invite a teammate</Heading>
              <Paragraph className="mt-1 text-ui-sm text-ink-soft">
                An invitation emails a set-up link to that address. Initial roles here can never
                include owner, admin or finance — grant those through the roster afterwards; they
                carry the owner-approval gate.
              </Paragraph>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-ui-sm text-ink">
                  Work email
                  <Input
                    className="mt-1 block w-full"
                    value={createEmail}
                    onChange={(e) => {
                      setCreateEmail(e.target.value);
                    }}
                    data-testid="team-create-email"
                  />
                </label>
                <label className="text-ui-sm text-ink">
                  Full name (optional)
                  <Input
                    className="mt-1 block w-full"
                    value={createName}
                    onChange={(e) => {
                      setCreateName(e.target.value);
                    }}
                    data-testid="team-create-name"
                  />
                </label>
              </div>
              <fieldset className="mt-3">
                <legend className="text-ui-sm text-ink">Initial roles</legend>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                  {INVITE_ROLES.map((role) => (
                    <label key={role} className="inline-flex items-center gap-2 text-ui-sm text-ink">
                      <input
                        type="checkbox"
                        checked={createRoles.includes(role)}
                        onChange={(e) => {
                          setCreateRoles((roles) =>
                            e.target.checked ? [...roles, role] : roles.filter((r) => r !== role),
                          );
                        }}
                        data-testid={`team-create-role-${role}`}
                      />
                      <span className="font-mono">{role}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {createError !== null && (
                <Paragraph className="mt-2 text-err font-medium" data-testid="team-create-error">
                  {createError}
                </Paragraph>
              )}
              <div className="mt-3">
                <Button data-testid="team-create-submit" disabled={creating} onClick={submitCreate}>
                  Create and email set-up link
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
