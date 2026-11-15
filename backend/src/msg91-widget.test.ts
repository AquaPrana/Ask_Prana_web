import { describe, expect, it, vi } from "vitest";
import { identityFromMsg91, requestMsg91Widget } from "./msg91-widget.js";
import { providerRequestId } from "./auth-routes.js";

const config = { authkey: "test-authkey", widgetId: "test-widget", baseUrl: "https://msg91.example/widget" };
const success = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(body) });

describe("MSG91 Widget contract", () => {
  it("sends widgetId, identifier and authkey for phone or email OTP", async () => {
    const fetcher = success({ type: "success", request_id: "request_12345678" });
    await requestMsg91Widget(config, "/sendOtp", { identifier: "919876543210" }, fetcher);
    expect(fetcher).toHaveBeenCalledWith("https://msg91.example/widget/sendOtp", expect.objectContaining({ headers: expect.objectContaining({ authkey: "test-authkey" }), body: JSON.stringify({ widgetId: "test-widget", identifier: "919876543210" }) }));
    await requestMsg91Widget(config, "/sendOtp", { identifier: "farmer@example.test" }, fetcher);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ widgetId: "test-widget", identifier: "farmer@example.test" });
  });

  it("uses documented retry and verify request payloads", async () => {
    const fetcher = success({ type: "success" });
    await requestMsg91Widget(config, "/retryOtp", { reqId: "request_12345678" }, fetcher);
    await requestMsg91Widget(config, "/verifyOtp", { reqId: "request_12345678", otp: "123456" }, fetcher);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ widgetId: "test-widget", reqId: "request_12345678" });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ widgetId: "test-widget", reqId: "request_12345678", otp: "123456" });
  });

  it("accepts MSG91's successful message-form request id", () => {
    expect(providerRequestId({ message: "request_12345678" })).toBe("request_12345678");
    expect(providerRequestId({ data: { request_id: "request_87654321" } })).toBe("request_87654321");
    expect(providerRequestId({ message: "OTP sent successfully" })).toBe("");
  });

  it.each([
    [{ type: "error", message: "Wrong OTP" }, "otp_invalid", 401],
    [{ type: "error", message: "OTP expired" }, "otp_expired", 401],
    [{ type: "error", message: "rate limit reached" }, "provider_rate_limited", 429],
    [{ type: "error", message: "AuthenticationFailure" }, "provider_auth_rejected", 503],
  ])("maps provider failures safely", async (body, code, status) => {
    await expect(requestMsg91Widget(config, "/verifyOtp", { reqId: "request_12345678", otp: "123456" }, success(body))).rejects.toMatchObject({ code, status });
  });

  it("rejects absent configuration and network failures without leaking values", async () => {
    await expect(requestMsg91Widget({ ...config, authkey: "" }, "/sendOtp", { identifier: "farmer@example.test" })).rejects.toMatchObject({ code: "missing_authkey" });
    await expect(requestMsg91Widget(config, "/sendOtp", { identifier: "farmer@example.test" }, vi.fn().mockRejectedValue(new Error("socket closed")))).rejects.toMatchObject({ code: "provider_network" });
  });

  it("extracts the verified identity from MSG91 data instead of a caller claim", () => {
    const token = `x.${Buffer.from(JSON.stringify({ email: "Farmer@Example.test" })).toString("base64url")}.x`;
    expect(identityFromMsg91({ type: "success", accessToken: token })).toEqual({ phone: null, email: "farmer@example.test" });
    expect(identityFromMsg91({ mobile: "919876543210" })).toEqual({ phone: "+919876543210", email: null });
    expect(identityFromMsg91("farmer@example.test")).toEqual({ phone: null, email: "farmer@example.test" });
  });
});
