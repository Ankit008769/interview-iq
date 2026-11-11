import mongoose, { Schema } from 'mongoose';

// Campus and placement-office organisations (roadmap D1). Every org-scoped record carries orgId, and every
// query for one is filtered by it together with the caller's active membership (routes/orgs.ts), so one
// organisation can never read another's data. Students share only what they agreed to when joining.
export const ORG_ROLES = ['admin', 'coordinator', 'student'] as const;
export type OrgRole = typeof ORG_ROLES[number];
// What a student agrees to share when joining; bump the version when it changes.
export const SHARING_VERSION = '2026-11-11.v1';

export interface IOrganization {
  name: string;
  joinCode: string;
  branding: { displayName?: string; accentColor?: string };
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date; updatedAt: Date;
}
const orgSchema = new Schema<IOrganization>({
  name: { type: String, required: true, maxlength: 120 },
  joinCode: { type: String, required: true, unique: true },
  branding: { type: new Schema({ displayName: { type: String, maxlength: 60 }, accentColor: { type: String, match: /^#[0-9a-f]{6}$/i } }, { _id: false }), default: {} },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
export const Organization = mongoose.model<IOrganization>('Organization', orgSchema, 'organizations');

export interface IMembership {
  orgId: mongoose.Types.ObjectId; userId: mongoose.Types.ObjectId; role: OrgRole;
  cohortIds: mongoose.Types.ObjectId[];
  rollNumber?: string;
  sharingVersion: string; sharingAcceptedAt: Date;
  createdAt: Date; updatedAt: Date;
}
const membershipSchema = new Schema<IMembership>({
  orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ORG_ROLES, required: true },
  cohortIds: { type: [Schema.Types.ObjectId], default: [] },
  rollNumber: { type: String, maxlength: 40 },
  sharingVersion: { type: String, required: true },
  sharingAcceptedAt: { type: Date, required: true },
}, { timestamps: true });
membershipSchema.index({ orgId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1 });
membershipSchema.index({ orgId: 1, cohortIds: 1 });
export const Membership = mongoose.model<IMembership>('Membership', membershipSchema, 'memberships');

// Bulk onboarding: an invitation waits for the person with that email to sign in and accept it.
export interface IInvitation {
  orgId: mongoose.Types.ObjectId; email: string; name?: string; role: OrgRole; cohortId?: mongoose.Types.ObjectId; rollNumber?: string;
  invitedBy: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date;
}
const invitationSchema = new Schema<IInvitation>({
  orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  name: { type: String, maxlength: 120 },
  role: { type: String, enum: ORG_ROLES, required: true },
  cohortId: { type: Schema.Types.ObjectId },
  rollNumber: { type: String, maxlength: 40 },
  invitedBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
invitationSchema.index({ orgId: 1, email: 1 }, { unique: true });
invitationSchema.index({ email: 1 });
export const Invitation = mongoose.model<IInvitation>('Invitation', invitationSchema, 'org_invitations');

// A cohort has its own join code, so a class can join straight into its cohort.
export interface ICohort { orgId: mongoose.Types.ObjectId; name: string; joinCode: string; createdAt: Date; updatedAt: Date }
const cohortSchema = new Schema<ICohort>({
  orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  name: { type: String, required: true, maxlength: 80 },
  joinCode: { type: String, required: true, unique: true },
}, { timestamps: true });
export const Cohort = mongoose.model<ICohort>('Cohort', cohortSchema, 'cohorts');

// An assignment points at practice the app already offers; completion is read from the student's own records.
export type AssignmentSpec =
  | { kind: 'interview'; type: 'Technical' | 'Behavioral' | 'HR'; topic: string; difficulty: 'Beginner' | 'Intermediate' | 'Advanced'; totalQuestions: number; style?: 'general' | 'product' | 'services' | 'startup' }
  | { kind: 'coding'; problemId: string }
  | { kind: 'design'; promptId: string };
export interface IAssignment {
  orgId: mongoose.Types.ObjectId; cohortId: mongoose.Types.ObjectId; title: string; spec: AssignmentSpec; dueAt: Date; pack?: string;
  createdBy: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date;
}
const assignmentSchema = new Schema<IAssignment>({
  orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  cohortId: { type: Schema.Types.ObjectId, ref: 'Cohort', required: true },
  title: { type: String, required: true, maxlength: 120 },
  spec: { type: Schema.Types.Mixed, required: true },
  dueAt: { type: Date, required: true },
  pack: { type: String, maxlength: 40 },
  createdBy: { type: Schema.Types.ObjectId, required: true },
}, { timestamps: true });
assignmentSchema.index({ orgId: 1, cohortId: 1, dueAt: 1 });
export const Assignment = mongoose.model<IAssignment>('Assignment', assignmentSchema, 'assignments');
