CREATE TYPE "public"."agent_action" AS ENUM('capture', 'partial_capture', 'request_evidence', 'void', 'escalate');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('CREATED', 'AUTHORIZED', 'IN_TRANSIT', 'EVIDENCE_SUBMITTED', 'VERIFYING', 'NEEDS_MORE_EVIDENCE', 'CAPTURED', 'PARTIALLY_CAPTURED', 'PAYOUT_PENDING', 'RIDER_PAID', 'SETTLED', 'ESCALATED', 'VOIDED', 'EXPIRED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('authorization', 'capture', 'void', 'refund');--> statement-breakpoint
CREATE TABLE "agent_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"proposed_action" "agent_action" NOT NULL,
	"final_action" "agent_action" NOT NULL,
	"confidence" real NOT NULL,
	"capture_amount_cents" integer,
	"reasoning" text NOT NULL,
	"evidence_summary" text NOT NULL,
	"checks" jsonb,
	"policy_notes" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"buyer_id" text NOT NULL,
	"rider_id" text,
	"status" "delivery_status" DEFAULT 'CREATED' NOT NULL,
	"amount_cents" integer NOT NULL,
	"rider_fee_cents" integer DEFAULT 0 NOT NULL,
	"captured_amount_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"delivery_address" text NOT NULL,
	"delivery_lat" double precision,
	"delivery_lng" double precision,
	"otp_hash" text,
	"paypal_order_id" text,
	"current_authorization_id" text,
	"authorized_at" timestamp with time zone,
	"honor_period_flagged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_paypal_order_id_unique" UNIQUE("paypal_order_id"),
	CONSTRAINT "deliveries_currency_usd" CHECK ("deliveries"."currency" = 'USD'),
	CONSTRAINT "deliveries_amount_nonneg" CHECK ("deliveries"."amount_cents" >= 0 AND "deliveries"."rider_fee_cents" >= 0),
	CONSTRAINT "deliveries_captured_lte_amount" CHECK ("deliveries"."captured_amount_cents" IS NULL OR "deliveries"."captured_amount_cents" <= "deliveries"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"paypal_id" text NOT NULL,
	"parent_paypal_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"amount_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text NOT NULL,
	"final_capture" boolean,
	"request_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_paypal_id_unique" UNIQUE("paypal_id"),
	CONSTRAINT "payments_currency_usd" CHECK ("payments"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"rider_id" text NOT NULL,
	"sender_batch_id" text NOT NULL,
	"paypal_batch_id" text,
	"paypal_item_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"batch_status" text,
	"item_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_sender_batch_id_unique" UNIQUE("sender_batch_id"),
	CONSTRAINT "payouts_paypal_batch_id_unique" UNIQUE("paypal_batch_id"),
	CONSTRAINT "payouts_currency_usd" CHECK ("payouts"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "riders" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"paypal_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"carrier" text NOT NULL,
	"carrier_name_other" text,
	"tracking_number" text NOT NULL,
	"pushed_to_paypal_at" timestamp with time zone,
	"paypal_capture_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"summary" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_rider_id_riders_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."riders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_decisions_delivery_idx" ON "agent_decisions" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "deliveries_status_idx" ON "deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deliveries_merchant_idx" ON "deliveries" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "deliveries_rider_idx" ON "deliveries" USING btree ("rider_id");--> statement-breakpoint
CREATE INDEX "payments_delivery_idx" ON "payments" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "payouts_delivery_idx" ON "payouts" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "shipments_delivery_idx" ON "shipments" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_events_type_idx" ON "webhook_events" USING btree ("event_type");