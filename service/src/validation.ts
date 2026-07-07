/**
 * Central Ajv factory. Our canonical schemas declare draft 2020-12, so we use the
 * Ajv2020 build; ajv-formats supplies date-time/uri/etc. The `.default ?? mod`
 * dance absorbs the ESM/CJS interop difference under NodeNext.
 */
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const AjvClass: any = (Ajv2020Module as any).default ?? Ajv2020Module;
const addFormats: any = (addFormatsModule as any).default ?? addFormatsModule;

export type Validator = { (data: unknown): boolean; errors?: { instancePath: string; message?: string }[] | null };

export function compileSchema(schema: object): Validator {
  const ajv = new AjvClass({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema) as Validator;
}
