CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"photo_path" text NOT NULL,
	"photo_hash" text NOT NULL,
	"photo_taken_at" timestamp with time zone,
	"lat" double precision,
	"lng" double precision,
	"gps_accuracy_m" real,
	"otp_submitted" boolean DEFAULT false NOT NULL,
	"checks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_delivery_attempt_unique" UNIQUE("delivery_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD COLUMN "evidence_id" text;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_delivery_idx" ON "evidence" USING btree ("delivery_id");--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_evidence_id_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."evidence"("id") ON DELETE no action ON UPDATE no action;