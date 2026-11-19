import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, fileInput } from "../client";
import { qk } from "../queryKeys";
import type * as Contract from "@ecomgen/contracts";
import type { Static } from "@sinclair/typebox";
export type UserTemplate = Static<typeof Contract.UserTemplateItemSchema>;
export type CreateUserTemplateInput = Static<typeof Contract.CreateUserTemplateInput>;
export type UpdateUserTemplateInput = Static<typeof Contract.UpdateUserTemplateInput>;
export function useUserTemplates() {
    return useQuery({
        queryKey: qk.userTemplates,
        queryFn: async () => (await invoke("listUserTemplates", {})).items,
        staleTime: 30000,
    });
}
export function useCreateUserTemplate() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: CreateUserTemplateInput) => invoke("createUserTemplate", {
            ...body
        }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.userTemplates }),
    });
}
export function useUpdateUserTemplate() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ templateId, body }: {
            templateId: string;
            body: UpdateUserTemplateInput;
        }) => invoke("updateUserTemplate", {
            ...{ templateId },
            ...body
        }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.userTemplates }),
    });
}
export function useDeleteUserTemplate() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (templateId: string) => {
            await invoke("deleteUserTemplate", {
                ...{ templateId }
            });
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.userTemplates }),
    });
}
