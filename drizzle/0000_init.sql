CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('queued', 'parsing', 'building', 'paused', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('pending', 'done', 'needs_review', 'failed', 'approved');--> statement-breakpoint
CREATE TYPE "public"."row_status" AS ENUM('pending', 'done', 'needs_review', 'failed');--> statement-breakpoint
CREATE TYPE "public"."translation_status" AS ENUM('machine', 'manual', 'out_of_date', 'failed');--> statement-breakpoint
CREATE TABLE "ai_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"provider_batch_id" text,
	"status" text NOT NULL,
	"requests" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"import_id" uuid,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"mode" text NOT NULL,
	"product_count" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_nanos" bigint DEFAULT 0 NOT NULL,
	"baseline_nanos" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"error" text,
	"vision" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"sheet_path" text NOT NULL,
	"photo_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "import_status" DEFAULT 'queued' NOT NULL,
	"phase" text,
	"total_rows" integer,
	"products_total" integer,
	"photo_count" integer DEFAULT 0 NOT NULL,
	"mode" text,
	"paused_until" timestamp with time zone,
	"pause_reason" text,
	"error" text,
	"stats" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_total_rows_limit" CHECK ("imports"."total_rows" IS NULL OR ("imports"."total_rows" >= 0 AND "imports"."total_rows" <= 10000))
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"media_type" text NOT NULL,
	"product_id" uuid,
	"sku" text,
	"match_method" text NOT NULL,
	"match_score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stable_key" text NOT NULL,
	"handle" text NOT NULL,
	"status" "product_status" DEFAULT 'pending' NOT NULL,
	"review_reason" text,
	"title" text,
	"description_html" text,
	"category" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dropped_claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_rows" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"corrections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input" jsonb,
	"content_hash" text NOT NULL,
	"built_hash" text,
	"last_import_id" uuid,
	"route" text,
	"model" text,
	"edited_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"merchant_note" text,
	"ai_cost_nanos" bigint DEFAULT 0 NOT NULL,
	"ai_input_tokens" integer DEFAULT 0 NOT NULL,
	"ai_output_tokens" integer DEFAULT 0 NOT NULL,
	"processing_ms" integer,
	"min_confidence" integer,
	"built_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"english_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_rows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"row_key" text NOT NULL,
	"raw" jsonb NOT NULL,
	"cleaned" jsonb NOT NULL,
	"language" text NOT NULL,
	"status" "row_status" DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"product_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_rows_reason_required" CHECK ("source_rows"."status" NOT IN ('needs_review', 'failed') OR "source_rows"."status_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "storefront_products" (
	"handle" text PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"category" text NOT NULL,
	"data" jsonb NOT NULL,
	"price_min_cents" integer,
	"currency" char(3),
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translation_cache" (
	"hash" text PRIMARY KEY NOT NULL,
	"locale" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"field" text NOT NULL,
	"text" text NOT NULL,
	"status" "translation_status" NOT NULL,
	"source_hash" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_cents" integer,
	"currency" char(3),
	"weight_grams" integer,
	"source_rows" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_price_positive" CHECK ("variants"."price_cents" IS NULL OR "variants"."price_cents" > 0),
	CONSTRAINT "variants_weight_positive" CHECK ("variants"."weight_grams" IS NULL OR "variants"."weight_grams" > 0),
	CONSTRAINT "variants_currency_iso" CHECK ("variants"."currency" IS NULL OR "variants"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "ai_batches" ADD CONSTRAINT "ai_batches_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_last_import_id_imports_id_fk" FOREIGN KEY ("last_import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_rows" ADD CONSTRAINT "source_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_rows" ADD CONSTRAINT "source_rows_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_products" ADD CONSTRAINT "storefront_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_batches_provider_uq" ON "ai_batches" USING btree ("provider_batch_id");--> statement-breakpoint
CREATE INDEX "ai_batches_import_idx" ON "ai_batches" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "ai_calls_created_idx" ON "ai_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_import_idx" ON "ai_calls" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "imports_created_idx" ON "imports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "imports_hash_idx" ON "imports" USING btree ("file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "photos_import_file_uq" ON "photos" USING btree ("import_id","file_name");--> statement-breakpoint
CREATE INDEX "photos_product_idx" ON "photos" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_stable_key_uq" ON "products" USING btree ("stable_key");--> statement-breakpoint
CREATE UNIQUE INDEX "products_handle_uq" ON "products" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "products_status_idx" ON "products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "products_last_import_idx" ON "products" USING btree ("last_import_id");--> statement-breakpoint
CREATE INDEX "products_updated_idx" ON "products" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "products_title_trgm_idx" ON "products" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "source_rows_import_row_uq" ON "source_rows" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "source_rows_import_status_idx" ON "source_rows" USING btree ("import_id","status");--> statement-breakpoint
CREATE INDEX "source_rows_product_idx" ON "source_rows" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_product_uq" ON "storefront_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "storefront_category_idx" ON "storefront_products" USING btree ("category","handle");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_product_locale_field_uq" ON "translations" USING btree ("product_id","locale","field");--> statement-breakpoint
CREATE INDEX "translations_status_idx" ON "translations" USING btree ("locale","status");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_sku_uq" ON "variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "variants_product_idx" ON "variants" USING btree ("product_id");