"use client";

import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

import { PrototypeNotice } from "@/components/common/prototype-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * VISUAL PROTOTYPE ONLY.
 *
 * The fields are not submitted, stored or checked anywhere and have no `name`
 * attributes. Real sign-in (e-mail + password + mandatory TOTP) will be
 * delegated to the chosen auth provider – do not add credential handling here.
 */
export function LoginForm() {
  const router = useRouter();

  return (
    <form
      className="mt-8 flex flex-col gap-5"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        router.push("/");
      }}
    >
      <PrototypeNotice>
        Detta är en visuell prototyp. Uppgifterna skickas inte och kontrolleras
        inte – du kommer direkt till demoläget.
      </PrototypeNotice>

      <div className="flex flex-col gap-2">
        <Label htmlFor="login-email">E-postadress</Label>
        <Input
          id="login-email"
          type="email"
          placeholder="fornamn.efternamn@exempel.se"
          autoComplete="off"
          className="h-10"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="login-password">Lösenord</Label>
        <Input
          id="login-password"
          type="password"
          autoComplete="off"
          className="h-10"
        />
      </div>

      <Button type="submit" size="lg" className="mt-1 h-10 w-full">
        Logga in
        <ArrowRight data-icon="inline-end" />
      </Button>

      <p className="text-caption text-center">
        I den färdiga versionen krävs även tvåstegsverifiering med
        autentiseringsapp.
      </p>
    </form>
  );
}
