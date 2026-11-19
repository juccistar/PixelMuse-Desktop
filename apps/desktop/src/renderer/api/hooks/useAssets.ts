import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adaptAsset, type UserAssetKind } from "../adapters/projectDetail";
import { invoke, fileInput } from "../client";
import { ApiError } from "../errors";
import { qk } from "../queryKeys";
export interface UploadAssetInput {
    projectId: string;
    file: File;
    kind: UserAssetKind;
}
export function useUploadAsset() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ projectId, file, kind }: UploadAssetInput) => {
            const raw = await invoke("uploadAsset", {
                ...{ projectId },
                ...{
                    file: await fileInput(file),
                    kind,
                }
            });
            const asset = adaptAsset(raw);
            if (!asset) {
                throw new ApiError({ code: "UNKNOWN", message: "上传响应无法解析" });
            }
            return asset;
        },
        onSuccess: (_asset, { projectId }) => {
            void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        },
    });
}
export function useDeleteAsset() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ assetId }: {
            assetId: string;
            projectId: string;
        }) => {
            await invoke("deleteAsset", {
                ...{ assetId }
            });
        },
        onSuccess: (_result, { projectId }) => {
            void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        },
    });
}
