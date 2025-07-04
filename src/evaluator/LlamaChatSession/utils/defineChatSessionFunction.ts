import {GbnfJsonDefList, GbnfJsonSchema, GbnfJsonSchemaToType} from "../../../utils/gbnfJson/types.js";
import {ChatSessionModelFunction} from "../../../types.js";

/**
 * Define a function that can be used by the model in a chat session, and return it.
 *
 * This is a helper function to facilitate defining functions with full TypeScript type information.
 *
 * The handler function can return a Promise, and the return value will be awaited before being returned to the model.
 * @param functionDefinition
 */
export function defineChatSessionFunction<
    const Params extends GbnfJsonSchema<Defs>,
    const Defs extends GbnfJsonDefList<Defs>
>({
    description,
    params,
    handler
}: {
    description?: string,
    params?: Readonly<Params> & GbnfJsonSchema<Defs>,
    handler: (params: GbnfJsonSchemaToType<NoInfer<Params>>) => Promise<any> | any
}): ChatSessionModelFunction<NoInfer<Params>> {
    return {
        description,
        params,
        handler
    };
}
