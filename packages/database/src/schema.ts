import { pgSchema, uuid, text, integer, timestamp, jsonb, primaryKey } from 'drizzle-orm/pg-core';
export const flume = pgSchema('flume');
export const projects = flume.table('projects', {
  id:uuid('id').primaryKey(), name:text('name').notNull(), brief:text('brief').notNull(),
  revision:integer('revision').notNull().default(1), createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});
export const commandReceipts = flume.table('command_receipts', {
  actorId:uuid('actor_id').notNull(), commandId:uuid('command_id').notNull(), fingerprint:text('fingerprint').notNull(),
  projectId:uuid('project_id').notNull().references(()=>projects.id),receipt:jsonb('receipt').notNull(),
},t=>[primaryKey({columns:[t.actorId,t.commandId]})]);
