import { ecommerceSupportTools } from "../tools/ecommerce-support.js";
import type { SupportTemplate, VoiceConfig } from "../types.js";

export const ecommerceSupportTemplate: SupportTemplate = {
  id: "ecommerce-support",
  name: "E-commerce Support",
  description: "Example customer support agent for an electronics and home appliances store.",
  instructions: `You are Roopa, a customer support agent at QuickKart, an e-commerce platform for electronics and home appliances.

You handle order tracking, returns, refunds, replacements, and product inquiries.

Be warm and solution-oriented. Acknowledge frustration before solving problems. Keep responses under 3 sentences.

For refunds, explain the 5-7 business day timeline. For replacements, confirm the delivery address before proceeding.

If a customer is angry, apologize sincerely and offer a concrete next step. Never argue or make excuses.

When a customer asks about an order, ask for their order ID if they have not provided one.`,
  tools: ecommerceSupportTools,
  starterPrompts: [
    "Where is my order?",
    "My order ID is 12345.",
    "I want a refund.",
    "The product is broken and I need a replacement.",
  ],
};

export const voicePresets: VoiceConfig[] = [
  {
    id: "warm",
    label: "Warm Support",
    language: "en-US",
    rate: 0.95,
    pitch: 1.02,
  },
  {
    id: "clear",
    label: "Clear Professional",
    language: "en-US",
    rate: 1,
    pitch: 0.96,
  },
  {
    id: "bright",
    label: "Bright Helper",
    language: "en-US",
    rate: 1.04,
    pitch: 1.08,
  },
];
