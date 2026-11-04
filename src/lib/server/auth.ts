import { APIError, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { and, eq, gt, sql } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "./db/index";
import { member, schema } from "./db/schema";

export const auth = betterAuth({
	secret: env.BETTER_AUTH_SECRET,
	baseURL: env.BETTER_AUTH_URL,
	// other addresses plank is opened from, e.g. "http://localhost:3300,http://192.168.100.100:3300"
	trustedOrigins: env.TRUSTED_ORIGINS?.split(",").map((origin) => origin.trim()) ?? [],
	database: drizzleAdapter(db, {
		provider: "sqlite",
		schema: {
			user: schema.user,
			session: schema.session,
			account: schema.account,
			verification: schema.verification,
			organization: schema.organization,
			member: schema.member,
			invitation: schema.invitation,
		},
	}),
	emailAndPassword: {
		enabled: true,
	},
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // 1 day
	},
	databaseHooks: {
		user: {
			create: {
				before: async (user) => {
					const existingUsers = db.select({ id: schema.user.id }).from(schema.user).limit(1).all();
					if (existingUsers.length === 0) {
						return { data: user };
					}

					const invitation = db
						.select({ id: schema.invitation.id })
						.from(schema.invitation)
						.where(
							and(
								eq(schema.invitation.email, user.email),
								eq(schema.invitation.status, "pending"),
								gt(schema.invitation.expiresAt, new Date())
							)
						)
						.limit(1)
						.get();

					if (!invitation) {
						throw new APIError("FORBIDDEN", { message: "Signup requires a pending invitation" });
					}

					return {
						data: user,
					};
				},
			},
		},
	},
	plugins: [
		organization({
			allowUserToCreateOrganization: async (user) => {
				const existingOrg = db.select({ id: schema.organization.id }).from(schema.organization).limit(1).get();
				if (!existingOrg) {
					return true;
				}

				const ownerMembership = db
					.select({ id: schema.member.id })
					.from(schema.member)
					.where(and(eq(schema.member.userId, user.id), eq(schema.member.role, "owner")))
					.limit(1)
					.get();

				return Boolean(ownerMembership);
			},
			organizationHooks: {
				beforeDeleteOrganization: async ({ organization }) => {
					// If its the last organization, reject the request
					const organizationCount =
						db.select({ count: sql<number>`count(*)` }).from(schema.organization).get()?.count ?? 0;
					if (organizationCount <= 1) {
						throw new APIError("FORBIDDEN", { message: "Cannot delete the last organization" });
					}

					// Deletes member from the organization by removing them from the member table
					db.delete(member)
						.where(and(eq(member.organizationId, organization.id)))
						.run();
				},
			},
		}),
	],
	telemetry: {
		enabled: false,
	},
});
