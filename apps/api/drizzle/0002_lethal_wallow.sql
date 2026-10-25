ALTER TABLE "agent_decisions" ADD COLUMN "rider_message" text;--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD COLUMN "tool_calls" jsonb;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "items" jsonb;--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "rider_note" text;--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_evidence_unique" UNIQUE("evidence_id");