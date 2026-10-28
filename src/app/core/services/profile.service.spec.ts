import { TestBed } from '@angular/core/testing';
import { AVATARS, DEFAULT_AVATAR_ID, NAME_LIMITS } from '../../../../shared/protocol';
import { isValidName, nameProblem, ProfileService, sanitizeName } from './profile.service';

const STORAGE_KEY = 'rr.profile';

describe('sanitizeName', () => {
  it('recorta, colapsa espacios y limita la longitud', () => {
    expect(sanitizeName('  Stiven   QA \n')).toBe('Stiven QA');
    expect(sanitizeName('\tAna\t')).toBe('Ana');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(NAME_LIMITS.max);
  });
});

describe('isValidName', () => {
  it('exige el mínimo de caracteres tras sanear', () => {
    expect(isValidName('')).toBe(false);
    expect(isValidName('   ')).toBe(false);
    expect(isValidName('a')).toBe(false);
    expect(isValidName(' a ')).toBe(false);
    expect(isValidName('Bo')).toBe(true);
    expect(isValidName('  Bea  ')).toBe(true);
  });

  it('aplica la misma regla de caracteres visibles que el servidor', () => {
    expect(isValidName('!!')).toBe(false);
    expect(isValidName('ㅤㅤ')).toBe(false);
    expect(isValidName('A​​')).toBe(false);
    expect(nameProblem('!!')).toContain('visibles');
    expect(isValidName('🎲🎲')).toBe(true);
    expect(isValidName('Ñandú')).toBe(true);
  });
});

describe('ProfileService', () => {
  beforeEach(() => localStorage.clear());

  const create = () => TestBed.inject(ProfileService);

  it('sin datos guardados empieza sin apodo y con un avatar válido', () => {
    const service = create();
    expect(service.profile().name).toBe('');
    expect(AVATARS.some((a) => a.id === service.profile().avatar)).toBe(true);
    expect(service.hasValidName()).toBe(false);
  });

  it('recupera el perfil guardado y corrige un avatar desconocido', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: 'Bea', avatar: 'nope' }));
    const service = create();
    expect(service.profile()).toEqual({ name: 'Bea', avatar: DEFAULT_AVATAR_ID });
    expect(service.hasValidName()).toBe(true);
  });

  it('ignora datos corruptos', () => {
    localStorage.setItem(STORAGE_KEY, '{no es json');
    expect(create().profile().name).toBe('');
  });

  it('persiste el apodo y el avatar', () => {
    const service = create();
    service.setName('Stiven');
    service.setAvatar('robot');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      name: 'Stiven',
      avatar: 'robot',
    });
  });

  it('no acepta avatares que no existen', () => {
    const service = create();
    service.setAvatar('robot');
    service.setAvatar('dragon');
    expect(service.profile().avatar).toBe('robot');
  });

  it('snapshot envía el apodo saneado', () => {
    const service = create();
    service.setName('  Ana   Bea ');
    expect(service.snapshot().name).toBe('Ana Bea');
  });

  it('randomName genera un apodo válido', () => {
    const service = create();
    const name = service.randomName();
    expect(isValidName(name)).toBe(true);
    expect(name.length).toBeLessThanOrEqual(NAME_LIMITS.max);
    expect(service.profile().name).toBe(name);
  });
});
