/** The settings sections. This table drives the nav and the server-side guards. */

import { redirect } from "@sveltejs/kit";
import { assert } from "$lib/utils";

export type SettingsRole = "member" | "admin" | "owner";

/** Roles in ascending order of access. A role reaches every section at or below its rank. */
const ROLE_ORDER: SettingsRole[] = ["member", "admin", "owner"];

/** Every role reaches this section. Guards send an unauthorized user here. */
const FALLBACK_HREF = "/settings/account";

export interface SettingsSection {
	href: string;
	label: string;
	group: string;
	minRole: SettingsRole;
}

const SECTIONS: SettingsSection[] = [
	{
		href: FALLBACK_HREF,
		label: "Account",
		group: "Personal",
		minRole: "member",
	},
	{
		href: "/settings/security",
		label: "Security",
		group: "Personal",
		minRole: "member",
	},
	{
		href: "/settings/profile",
		label: "Profile",
		group: "Profile",
		minRole: "member",
	},
	{
		href: "/settings/members",
		label: "Members",
		group: "Profile",
		minRole: "admin",
	},
	{
		href: "/settings/connections",
		label: "Connections",
		group: "System",
		minRole: "owner",
	},
	{
		href: "/settings/playback",
		label: "Playback & downloads",
		group: "System",
		minRole: "owner",
	},
	{
		href: "/settings/indexers",
		label: "Indexers",
		group: "System",
		minRole: "owner",
	},
];

function rank(role: SettingsRole): number {
	const index = ROLE_ORDER.indexOf(role);
	assert(index >= 0, `rank: unknown role ${role}`);
	return index;
}

/** Narrow a role string from the auth API. An unknown role gets the lowest access. */
export function toSettingsRole(role: string | null | undefined): SettingsRole {
	if (role === "owner" || role === "admin" || role === "member") {
		return role;
	}
	return "member";
}

export function visibleSections(role: SettingsRole): SettingsSection[] {
	return SECTIONS.filter((section) => rank(role) >= rank(section.minRole));
}

export function findSection(href: string): SettingsSection | undefined {
	return SECTIONS.find((section) => section.href === href);
}

/** Redirect to the fallback section when the role cannot reach this one. */
export function requireSection(role: SettingsRole, href: string): void {
	const section = findSection(href);
	assert(section !== undefined, `requireSection: unknown section ${href}`);
	if (rank(role) < rank(section.minRole)) {
		redirect(302, FALLBACK_HREF);
	}
}
