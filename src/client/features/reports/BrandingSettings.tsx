import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getClientProfile,
  getOrganizationBranding,
  setClientProfile,
  setOrganizationBranding,
} from "@/serverFunctions/branding";

const LOGO_ACCEPT = "image/png,image/jpeg";
const LOGO_MAX_BYTES = 512 * 1024;

function readLogoFile(file: File): Promise<string> {
  if (!["image/png", "image/jpeg"].includes(file.type)) {
    return Promise.reject(new Error("Logo must be a PNG or JPEG file."));
  }
  if (file.size > LOGO_MAX_BYTES || file.size === 0) {
    return Promise.reject(new Error("Logo must be under 512 KB."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read the logo file."));
    });
    reader.addEventListener("error", () =>
      reject(new Error("Could not read the logo file.")),
    );
    reader.readAsDataURL(file);
  });
}

function LogoPicker({
  currentKey,
  pending,
  onSelect,
  onRemove,
}: {
  currentKey: string | null;
  pending: boolean;
  onSelect: (dataUrl: string) => void;
  onRemove: () => void;
}) {
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    void readLogoFile(file).then(onSelect, (error: unknown) => {
      toast.error(
        error instanceof Error ? error.message : "Could not read the file.",
      );
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      {currentKey ? (
        <img
          src={`/api/brand-logo?key=${encodeURIComponent(currentKey)}`}
          alt="Current logo"
          className="h-10 max-w-40 object-contain"
        />
      ) : (
        <span className="text-sm text-base-content/50">No logo</span>
      )}
      <label className="btn btn-outline btn-sm">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Upload logo
        <input
          type="file"
          accept={LOGO_ACCEPT}
          className="hidden"
          disabled={pending}
          onChange={pick}
        />
      </label>
      {currentKey ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={pending}
          onClick={onRemove}
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}

export function AgencyBrandingSection() {
  const queryClient = useQueryClient();
  const brandingQuery = useQuery({
    queryKey: ["branding", "organization"],
    queryFn: () => getOrganizationBranding(),
  });
  const branding = brandingQuery.data?.branding ?? null;
  const [agencyName, setAgencyName] = React.useState<string | null>(null);
  const [accentColor, setAccentColor] = React.useState<string | null>(null);
  const [footerText, setFooterText] = React.useState<string | null>(null);
  const [logoDataUrl, setLogoDataUrl] = React.useState<string | undefined>();
  const [removeLogo, setRemoveLogo] = React.useState(false);

  const mutation = useMutation({
    mutationFn: (input: {
      agencyName: string;
      accentColor: string | null;
      footerText: string | null;
      logoDataUrl?: string;
      removeLogo?: boolean;
    }) => setOrganizationBranding({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["branding"] });
      setLogoDataUrl(undefined);
      setRemoveLogo(false);
      toast.success("Agency branding saved");
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Failed to save branding")),
  });

  const name = agencyName ?? branding?.agencyName ?? "";
  const color = accentColor ?? branding?.accentColor ?? "";
  const footer = footerText ?? branding?.footerText ?? "";

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (mutation.isPending || !name.trim()) return;
    mutation.mutate({
      agencyName: name.trim(),
      accentColor: color.trim() || null,
      footerText: footer.trim() || null,
      ...(logoDataUrl !== undefined ? { logoDataUrl } : {}),
      ...(removeLogo ? { removeLogo: true } : {}),
    });
  };

  if (brandingQuery.isPending) {
    return <span className="loading loading-spinner loading-md" />;
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <p className="text-xs text-base-content/50">
        Organization-wide: applies to every project&apos;s shared reports.
      </p>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Agency name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setAgencyName(event.target.value)}
          maxLength={120}
          placeholder="Acme SEO"
          className="input input-bordered w-full"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Accent color</span>
        <input
          type="text"
          value={color}
          onChange={(event) => setAccentColor(event.target.value)}
          placeholder="#1a2b3c"
          maxLength={7}
          className="input input-bordered w-full"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Footer text</span>
        <input
          type="text"
          value={footer}
          onChange={(event) => setFooterText(event.target.value)}
          maxLength={500}
          placeholder="Prepared by Acme SEO"
          className="input input-bordered w-full"
        />
      </label>
      <LogoPicker
        currentKey={removeLogo ? null : (branding?.agencyLogoR2Key ?? null)}
        pending={mutation.isPending}
        onSelect={(dataUrl) => {
          setLogoDataUrl(dataUrl);
          setRemoveLogo(false);
        }}
        onRemove={() => {
          setLogoDataUrl(undefined);
          setRemoveLogo(true);
        }}
      />
      {logoDataUrl !== undefined ? (
        <p className="text-xs text-base-content/50">
          New logo selected — save to upload it.
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={mutation.isPending || !name.trim()}
        >
          Save branding
        </button>
      </div>
    </form>
  );
}

export function ClientProfileSection({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ["branding", "client", projectId],
    queryFn: () => getClientProfile({ data: { projectId } }),
  });
  const profile = profileQuery.data?.profile ?? null;
  const [clientName, setClientName] = React.useState<string | null>(null);
  const [titleOverride, setTitleOverride] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState<string | null>(null);
  const [logoDataUrl, setLogoDataUrl] = React.useState<string | undefined>();
  const [removeLogo, setRemoveLogo] = React.useState(false);

  const mutation = useMutation({
    mutationFn: (input: {
      projectId: string;
      clientName: string;
      reportTitleOverride: string | null;
      notes: string | null;
      logoDataUrl?: string;
      removeLogo?: boolean;
    }) => setClientProfile({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["branding"] });
      setLogoDataUrl(undefined);
      setRemoveLogo(false);
      toast.success("Client profile saved");
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Failed to save profile")),
  });

  const name = clientName ?? profile?.clientName ?? "";
  const title = titleOverride ?? profile?.reportTitleOverride ?? "";
  const notesValue = notes ?? profile?.notes ?? "";

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (mutation.isPending || !name.trim()) return;
    mutation.mutate({
      projectId,
      clientName: name.trim(),
      reportTitleOverride: title.trim() || null,
      notes: notesValue.trim() || null,
      ...(logoDataUrl !== undefined ? { logoDataUrl } : {}),
      ...(removeLogo ? { removeLogo: true } : {}),
    });
  };

  if (profileQuery.isPending) {
    return <span className="loading loading-spinner loading-md" />;
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <p className="text-xs text-base-content/50">
        Per-project: frozen into new reports at generation time. Notes stay
        internal and are never shared.
      </p>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Client name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setClientName(event.target.value)}
          maxLength={120}
          placeholder="Client Co"
          className="input input-bordered w-full"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Report title override</span>
        <input
          type="text"
          value={title}
          onChange={(event) => setTitleOverride(event.target.value)}
          maxLength={120}
          placeholder="Q1 SEO review"
          className="input input-bordered w-full"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Internal notes</span>
        <textarea
          value={notesValue}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="Never included in shared reports."
          className="textarea textarea-bordered w-full"
        />
      </label>
      <LogoPicker
        currentKey={removeLogo ? null : (profile?.clientLogoR2Key ?? null)}
        pending={mutation.isPending}
        onSelect={(dataUrl) => {
          setLogoDataUrl(dataUrl);
          setRemoveLogo(false);
        }}
        onRemove={() => {
          setLogoDataUrl(undefined);
          setRemoveLogo(true);
        }}
      />
      <div className="flex justify-end">
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={mutation.isPending || !name.trim()}
        >
          Save profile
        </button>
      </div>
    </form>
  );
}
