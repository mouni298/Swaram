import type { ToolDefinition } from "../types.js";

const statuses = ["out for delivery", "shipped", "processing", "packed for dispatch"];

function getString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function statusForOrder(orderId: string) {
  const total = orderId.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return statuses[total % statuses.length] ?? "processing";
}

function stableNumber(seed: string, base: number, span: number) {
  const total = seed.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return base + (total % span);
}

export const ecommerceSupportTools: ToolDefinition[] = [
  {
    name: "lookup_order",
    description: "Look up the current shipping status for a demo store order.",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "The customer's order ID." },
      },
      required: ["orderId"],
    },
    run(args) {
      const orderId = getString(args, "orderId") ?? "UNKNOWN";
      const status = statusForOrder(orderId);

      return {
        orderId,
        status,
        carrier: "QuickKart Logistics",
        deliveryDate:
          status === "out for delivery"
            ? "today by 8 PM"
            : status === "shipped"
              ? "within 2 business days"
              : "within 4 business days",
      };
    },
  },
  {
    name: "check_return_eligibility",
    description: "Check whether an order or item is eligible for return.",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "The order ID to check." },
        itemName: { type: "string", description: "The specific item to check, if known." },
      },
      required: ["orderId"],
    },
    run(args) {
      return {
        orderId: getString(args, "orderId"),
        itemName: getString(args, "itemName"),
        eligible: true,
        returnWindow: "10 days remaining",
        refundTimeline: "5-7 business days after pickup inspection",
      };
    },
  },
  {
    name: "create_return_request",
    description: "Create a return request for an eligible order.",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "The order ID to return." },
        reason: { type: "string", description: "Why the customer is returning the order." },
      },
      required: ["orderId"],
    },
    run(args) {
      const orderId = getString(args, "orderId") ?? "UNKNOWN";

      return {
        orderId,
        reason: getString(args, "reason") ?? "Customer requested return",
        requestId: `RET-${stableNumber(orderId, 100000, 900000)}`,
        pickupWindow: "next 2 business days",
        refundTimeline: "5-7 business days",
      };
    },
  },
  {
    name: "create_support_ticket",
    description: "Create a support ticket for follow-up or escalation.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A short summary of the customer's issue." },
        priority: { type: "string", enum: ["normal", "high"], description: "Ticket priority." },
      },
      required: ["summary"],
    },
    run(args) {
      const priority = getString(args, "priority") ?? "normal";
      const summary = getString(args, "summary") ?? "Customer needs support";

      return {
        ticketId: `QK-${stableNumber(summary, 10000, 90000)}`,
        summary,
        priority,
        owner: priority === "high" ? "Escalations team" : "Customer support",
        status: "open",
      };
    },
  },
  {
    name: "search_policy",
    description: "Search demo support policy information.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "The policy topic, e.g. refund, return, warranty, replacement.",
        },
      },
      required: ["topic"],
    },
    run(args) {
      const topic = getString(args, "topic") ?? "general";
      const normalized = topic.toLowerCase();
      let answer = "Support can help with orders, returns, refunds, and product questions.";

      if (normalized.includes("refund")) {
        answer = "Refunds are initiated after pickup inspection and usually take 5-7 business days.";
      } else if (normalized.includes("return")) {
        answer = "Most electronics and appliances can be returned within 10 days if they are undamaged and include accessories.";
      } else if (normalized.includes("warranty")) {
        answer = "Warranty coverage depends on the brand and product category, and the invoice is required for service claims.";
      } else if (normalized.includes("replacement")) {
        answer = "Replacements require address confirmation before dispatch.";
      }

      return {
        topic,
        answer,
      };
    },
  },
];

export { ecommerceSupportTools as ecommerceTools };
