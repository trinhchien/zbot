// Domain types used across the application

export type UserRole = 'member' | 'organizer' | 'treasurer' | 'admin';

export type EventStatus = 'planning' | 'confirmed' | 'done' | 'cancelled';

export type RsvpStatus = 'yes' | 'no' | 'maybe' | 'pending';

export type TaskStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'cancelled';

export type TaskPriority = 'low' | 'normal' | 'high';

export type ContributionStatus = 'pending' | 'verified' | 'rejected';

export type CampaignStatus = 'open' | 'closed' | 'cancelled';

export type FactCategory = 'personal' | 'preference' | 'dietary' | 'contact' | 'role' | 'commitment' | 'other';
