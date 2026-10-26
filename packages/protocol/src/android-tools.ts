import { Type, type TSchema } from "typebox";
import type { ControlToolCatalogDefinition } from "./control-tool-catalog.ts";

export const ANDROID_CAPABILITIES = [
  "screen.observe",
  "screen.tap",
  "screen.swipe",
  "text.input",
  "navigation.key",
  "app.launch",
] as const;
export const ANDROID_OPERATION_TIMEOUT_MS = 30_000;
export const ANDROID_REPLY_TIMEOUT_MS = 90_000;
const coordinate = Type.Integer({ minimum: 0, maximum: 16384 });
const tool = (
  name: string,
  description: string,
  capability: string,
  parameters: TSchema,
): ControlToolCatalogDefinition => ({
  name,
  description,
  environment: { kind: "target", targetKind: "android", capabilities: [capability] },
  parameters: JSON.parse(JSON.stringify(parameters)),
});
export const androidToolDefinitions = (): ControlToolCatalogDefinition[] => [
  tool(
    "android_observe",
    "Observe the bound Android screen. Returns a screenshot, display dimensions, foreground app and a bounded UI hierarchy. Use it to inspect effects before repeating an uncertain action.",
    "screen.observe",
    Type.Object({}, { additionalProperties: false }),
  ),
  tool(
    "android_tap",
    "Tap the bound Android screen at the supplied pixel coordinates. Use coordinates from a recent observation. Completion confirms delivery of the input, not a business action such as a payment.",
    "screen.tap",
    Type.Object({ x: coordinate, y: coordinate }, { additionalProperties: false }),
  ),
  tool(
    "android_swipe",
    "Swipe on the bound Android screen using pixel coordinates from a recent observation.",
    "screen.swipe",
    Type.Object(
      {
        fromX: coordinate,
        fromY: coordinate,
        toX: coordinate,
        toY: coordinate,
        durationMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 3000 })),
      },
      { additionalProperties: false },
    ),
  ),
  tool(
    "android_input_text",
    "Enter text in the focused editable Android control. Text is passed to the UI automation driver, never interpreted as shell code. Observe the screen afterwards to confirm the intended field.",
    "text.input",
    Type.Object({ text: Type.String({ maxLength: 10000 }) }, { additionalProperties: false }),
  ),
  tool(
    "android_key",
    "Press a navigation key on the bound Android device.",
    "navigation.key",
    Type.Object(
      {
        key: Type.Union([
          Type.Literal("back"),
          Type.Literal("home"),
          Type.Literal("enter"),
          Type.Literal("recent"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
  tool(
    "android_open_app",
    "Open an installed application on the bound Android device by package name. This does not install APKs or grant permissions.",
    "app.launch",
    Type.Object(
      {
        packageName: Type.String({
          pattern: "^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+$",
          maxLength: 255,
        }),
      },
      { additionalProperties: false },
    ),
  ),
];
