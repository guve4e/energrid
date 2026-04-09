export function getQuestionForMissing(field: string): string {
  switch (field) {
    case 'scope':
      return 'Опишете какво точно искате да се направи — например контакти, осветление, табло, бойлер, печка или друго.';

    case 'point.quantity':
      return 'Колко точки ще се изграждат?';

    case 'point.routeLengthMeters':
      return 'Каква е приблизителната дължина на трасето в метри?';

    case 'device.quantity':
      return 'Колко броя устройства са?';

    case 'panel.quantity':
      return 'Колко табла са?';

    default:
      return 'Дайте още малко конкретика, за да продължим с ориентировъчната сметка.';
  }
}
