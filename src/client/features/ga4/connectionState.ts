export function shouldShowPropertyPicker(input: {
  connected: boolean;
  picking: boolean;
  hasGrant: boolean;
}) {
  return input.picking || (!input.connected && input.hasGrant);
}
