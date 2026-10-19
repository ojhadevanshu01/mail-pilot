import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "./app.js";

describe("GET /health", () => {
  it("returns status ok and service name", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "mailpilot-api",
    });
  });
});
