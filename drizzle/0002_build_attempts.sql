ALTER TABLE "products" ADD COLUMN "build_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "last_error" text;