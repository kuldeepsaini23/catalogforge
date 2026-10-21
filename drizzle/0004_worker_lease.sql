CREATE TABLE "worker_lease" (
	"id" integer PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"holder" text
);
