import { useHomeRecoverySubscription } from '@/api/home-recovery'

export function HomeRecoveryController() {
  useHomeRecoverySubscription()
  return null
}
