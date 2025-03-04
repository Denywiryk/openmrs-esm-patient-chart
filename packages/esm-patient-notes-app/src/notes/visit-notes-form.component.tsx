import React, { SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import debounce from 'lodash-es/debounce';
import {
  Button,
  ButtonSet,
  Column,
  DatePicker,
  DatePickerInput,
  Form,
  FormGroup,
  Layer,
  Row,
  Search,
  SearchSkeleton,
  Stack,
  Tag,
  TextArea,
  Tile,
  SkeletonText,
} from '@carbon/react';
import { Add, WarningFilled } from '@carbon/react/icons';
import {
  createErrorHandler,
  ExtensionSlot,
  showNotification,
  showToast,
  useConfig,
  useLayoutType,
  useSession,
} from '@openmrs/esm-framework';
import {
  fetchConceptDiagnosisByName,
  savePatientDiagnosis,
  saveVisitNote,
  useVisitNotes,
} from './visit-notes.resource';
import { ConfigObject } from '../config-schema';
import { Concept, Diagnosis, DiagnosisPayload, VisitNotePayload } from '../types';
import { DefaultWorkspaceProps } from '@openmrs/esm-patient-common-lib';
import styles from './visit-notes-form.scss';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, Controller, Control, FormState } from 'react-hook-form';
import { z } from 'zod';

const visitNoteFormSchema = z.object({
  noteDate: z.date(),
  primaryDiagnosisSearch: z.string({
    required_error: 'Choose atleast one primary diagnosis',
  }),
  secondaryDiagnosisSearch: z.string().optional(),
  clinicalNote: z.string().optional(),
});

type VisitNotesFormData = z.infer<typeof visitNoteFormSchema>;

const VisitNotesForm: React.FC<DefaultWorkspaceProps> = ({ closeWorkspace, patientUuid }) => {
  const searchTimeoutInMs = 500;
  const { t } = useTranslation();
  const isTablet = useLayoutType() === 'tablet';
  const session = useSession();
  const config = useConfig() as ConfigObject;
  const state = useMemo(() => ({ patientUuid }), [patientUuid]);
  const { clinicianEncounterRole, encounterNoteTextConceptUuid, encounterTypeUuid, formConceptUuid } =
    config.visitNoteConfig;
  const [isHandlingSubmit, setIsHandlingSubmit] = useState(false);
  const [loadingPrimary, setLoadingPrimary] = useState<boolean>(false);
  const [loadingSecondary, setLoadingSecondary] = useState<boolean>(false);
  const [selectedPrimaryDiagnoses, setSelectedPrimaryDiagnoses] = useState<Array<Diagnosis>>([]);
  const [selectedSecondaryDiagnoses, setSelectedSecondaryDiagnoses] = useState<Array<Diagnosis>>([]);
  const [searchPrimaryResults, setSearchPrimaryResults] = useState<Array<Concept>>([]);
  const [searchSecondaryResults, setSearchSecondaryResults] = useState<Array<Concept>>([]);
  const [combinedDiagnoses, setCombinedDiagnoses] = useState<Array<Diagnosis>>([]);
  const [rows, setRows] = useState<number>();

  const { control, handleSubmit, watch, getValues, setValue, formState } = useForm<VisitNotesFormData>({
    mode: 'onSubmit',
    resolver: zodResolver(visitNoteFormSchema),
    defaultValues: {
      noteDate: new Date(),
    },
  });

  const { mutateVisitNotes } = useVisitNotes(patientUuid);
  const locationUuid = session?.sessionLocation?.uuid;
  const providerUuid = session?.currentProvider?.uuid;

  const handleSearch = (fieldName) => {
    const fieldQuery = watch(fieldName);
    if (fieldQuery) {
      debouncedSearch(fieldQuery, fieldName);
    }
  };

  const debouncedSearch = useMemo(
    () =>
      debounce((fieldQuery, fieldName) => {
        if (fieldQuery) {
          if (fieldName === 'primaryDiagnosisSearch') {
            setLoadingPrimary(true);
          } else if (fieldName === 'secondaryDiagnosisSearch') {
            setLoadingSecondary(true);
          }
          const sub = fetchConceptDiagnosisByName(fieldQuery).subscribe(
            (matchingConceptDiagnoses: Array<Concept>) => {
              if (fieldName == 'primaryDiagnosisSearch') {
                setSearchPrimaryResults(matchingConceptDiagnoses);
                setLoadingPrimary(false);
              } else if (fieldName == 'secondaryDiagnosisSearch') {
                setSearchSecondaryResults(matchingConceptDiagnoses);
                setLoadingSecondary(false);
              }
            },
            () => createErrorHandler(),
          );
          return () => {
            sub.unsubscribe();
          };
        }
      }, searchTimeoutInMs),
    [],
  );

  const handleAddDiagnosis = (conceptDiagnosisToAdd: Concept, searchInputField: string) => {
    let newDiagnosis = createDiagnosis(conceptDiagnosisToAdd);
    if (searchInputField == 'primaryDiagnosisSearch') {
      newDiagnosis.rank = 1;
      setValue('primaryDiagnosisSearch', '');
      setSearchPrimaryResults([]);
      setSelectedPrimaryDiagnoses((selectedDiagnoses) => [...selectedDiagnoses, newDiagnosis]);
    } else if (searchInputField == 'secondaryDiagnosisSearch') {
      setValue('secondaryDiagnosisSearch', '');
      setSearchSecondaryResults([]);
      setSelectedSecondaryDiagnoses((selectedDiagnoses) => [...selectedDiagnoses, newDiagnosis]);
    }
    setCombinedDiagnoses((diagnosisCombined) => [...diagnosisCombined, newDiagnosis]);
  };

  const handleRemoveDiagnosis = (diagnosisToRemove: Diagnosis, searchInputField: string) => {
    if (searchInputField == 'primaryInputSearch') {
      setSelectedPrimaryDiagnoses(
        selectedPrimaryDiagnoses.filter((diagnosis) => diagnosis.diagnosis.coded !== diagnosisToRemove.diagnosis.coded),
      );
    } else if (searchInputField == 'secondaryInputSearch') {
      setSelectedSecondaryDiagnoses(
        selectedSecondaryDiagnoses.filter(
          (diagnosis) => diagnosis.diagnosis.coded !== diagnosisToRemove.diagnosis.coded,
        ),
      );
    }
    setCombinedDiagnoses(
      combinedDiagnoses.filter((diagnosis) => diagnosis.diagnosis.coded !== diagnosisToRemove.diagnosis.coded),
    );
  };

  const createDiagnosis = (concept: Concept) => {
    return {
      patient: patientUuid,
      diagnosis: {
        coded: concept.uuid,
      },
      rank: 2,
      certainty: 'PROVISIONAL',
      display: concept.display,
    };
  };

  const onSubmit = useCallback(
    (data: VisitNotesFormData, event: SyntheticEvent) => {
      const { noteDate, clinicalNote } = data;
      setIsHandlingSubmit(true);

      if (!selectedPrimaryDiagnoses.length) {
        setIsHandlingSubmit(false);
        return;
      }

      let visitNotePayload: VisitNotePayload = {
        encounterDatetime: dayjs(noteDate).format(),
        form: formConceptUuid,
        patient: patientUuid,
        location: locationUuid,
        encounterProviders: [
          {
            encounterRole: clinicianEncounterRole,
            provider: providerUuid,
          },
        ],
        encounterType: encounterTypeUuid,
        obs: clinicalNote
          ? [{ concept: { uuid: encounterNoteTextConceptUuid, display: '' }, value: clinicalNote }]
          : [],
      };

      const abortController = new AbortController();
      saveVisitNote(abortController, visitNotePayload)
        .then((response) => {
          if (response.status === 201) {
            return Promise.all(
              combinedDiagnoses.map((diagnosis, position: number) => {
                const diagnosisPayload: DiagnosisPayload = {
                  encounter: response.data.uuid,
                  patient: patientUuid,
                  condition: null,
                  diagnosis: {
                    coded: diagnosis.diagnosis.coded,
                  },
                  certainty: diagnosis.certainty,
                  rank: diagnosis.rank,
                };
                return savePatientDiagnosis(abortController, diagnosisPayload);
              }),
            );
          }
        })
        .then(() => {
          mutateVisitNotes();
          closeWorkspace();

          showToast({
            critical: true,
            description: t('visitNoteNowVisible', 'It is now visible on the Encounters page'),
            kind: 'success',
            title: t('visitNoteSaved', 'Visit note saved'),
          });
        })
        .catch((err) => {
          createErrorHandler();

          showNotification({
            title: t('visitNoteSaveError', 'Error saving visit note'),
            kind: 'error',
            critical: true,
            description: err?.message,
          });
        })
        .finally(() => {
          setIsHandlingSubmit(false);
          abortController.abort();
        });
    },
    [
      selectedPrimaryDiagnoses.length,
      formConceptUuid,
      patientUuid,
      locationUuid,
      clinicianEncounterRole,
      providerUuid,
      encounterTypeUuid,
      encounterNoteTextConceptUuid,
      combinedDiagnoses,
      mutateVisitNotes,
      closeWorkspace,
      t,
    ],
  );

  const onError = (errors) => console.error(errors);

  return (
    <Form className={styles.form} onSubmit={handleSubmit(onSubmit, onError)}>
      {isTablet && (
        <Row className={styles.headerGridRow}>
          <ExtensionSlot name="visit-form-header-slot" className={styles.dataGridRow} state={state} />
        </Row>
      )}
      <Stack className={styles.formContainer} gap={2}>
        {isTablet ? <h2 className={styles.heading}>{t('addVisitNote', 'Add a visit note')}</h2> : null}
        <Row className={styles.row}>
          <Column sm={1}>
            <span className={styles.columnLabel}>{t('date', 'Date')}</span>
          </Column>
          <Column sm={3}>
            <Controller
              name="noteDate"
              control={control}
              render={({ field: { onChange, value } }) => (
                <DatePicker
                  dateFormat="d/m/Y"
                  datePickerType="single"
                  light={isTablet}
                  maxDate={new Date().toISOString()}
                  value={value}
                  onChange={([date]) => onChange(date)}
                >
                  <DatePickerInput
                    id="visitDateTimePicker"
                    labelText={t('visitDate', 'Visit date')}
                    placeholder="dd/mm/yyyy"
                  />
                </DatePicker>
              )}
            />
          </Column>
        </Row>
        <Row className={styles.row}>
          <Column sm={1}>
            <span className={styles.columnLabel}>{t('primaryDiagnosis', 'Primary diagnosis')}</span>
          </Column>
          <Column sm={3}>
            <div className={styles.diagnosesText} style={{ marginBottom: '1.188rem' }}>
              {selectedPrimaryDiagnoses && selectedPrimaryDiagnoses.length ? (
                <>
                  {selectedPrimaryDiagnoses.map((diagnosis, index) => (
                    <Tag
                      filter
                      key={index}
                      onClose={() => handleRemoveDiagnosis(diagnosis, 'primaryInputSearch')}
                      style={{ marginRight: '0.5rem' }}
                      type={'red'}
                    >
                      {diagnosis.display}
                    </Tag>
                  ))}
                </>
              ) : (
                <></>
              )}
              {selectedSecondaryDiagnoses && selectedSecondaryDiagnoses.length ? (
                <>
                  {selectedSecondaryDiagnoses.map((diagnosis, index) => (
                    <Tag
                      filter
                      key={index}
                      onClose={() => handleRemoveDiagnosis(diagnosis, 'secondaryInputSearch')}
                      style={{ marginRight: '0.5rem' }}
                      type={'blue'}
                    >
                      {diagnosis.display}
                    </Tag>
                  ))}
                </>
              ) : (
                <></>
              )}
              {selectedPrimaryDiagnoses &&
                !selectedPrimaryDiagnoses.length &&
                selectedSecondaryDiagnoses &&
                !selectedSecondaryDiagnoses.length && (
                  <span>{t('emptyDiagnosisText', 'No diagnosis selected — Enter a diagnosis below')}</span>
                )}
            </div>
            <FormGroup legendText={t('searchForPrimaryDiagnosis', 'Search for a primary diagnosis')}>
              <DiagnosisSearch
                name="primaryDiagnosisSearch"
                control={control}
                labelText={t('enterPrimaryDiagnoses', 'Enter Primary diagnoses')}
                placeholder={t('primaryDiagnosisInputPlaceholder', 'Choose a primary diagnosis')}
                handleSearch={handleSearch}
                error={formState?.errors?.primaryDiagnosisSearch}
              />
              <div>
                {(() => {
                  if (!getValues('primaryDiagnosisSearch')) return null;
                  if (loadingPrimary)
                    return (
                      <>
                        <SkeletonText className={styles.skeleton} />
                        <SkeletonText className={styles.skeleton} />
                        <SkeletonText className={styles.skeleton} />
                        <SkeletonText className={styles.skeleton} />
                        <SkeletonText className={styles.skeleton} />
                      </>
                    );
                  if (!loadingPrimary && searchPrimaryResults && searchPrimaryResults.length > 0) {
                    return (
                      <ul className={styles.diagnosisList}>
                        {searchPrimaryResults.map((diagnosis, index) => (
                          <li
                            role="menuitem"
                            className={styles.diagnosis}
                            key={index}
                            onClick={() => handleAddDiagnosis(diagnosis, 'primaryDiagnosisSearch')}
                          >
                            {diagnosis.display}
                          </li>
                        ))}
                      </ul>
                    );
                  }
                  return (
                    <>
                      {isTablet ? (
                        <Layer>
                          <Tile className={styles.emptyResults}>
                            <span>
                              {t('noMatchingDiagnoses', 'No diagnoses found matching')}{' '}
                              <strong>"{watch('primaryDiagnosisSearch')}"</strong>
                            </span>
                          </Tile>
                        </Layer>
                      ) : (
                        <Tile className={styles.emptyResults}>
                          <span>
                            {t('noMatchingDiagnoses', 'No diagnoses found matching')}{' '}
                            <strong>"{watch('primaryDiagnosisSearch')}"</strong>
                          </span>
                        </Tile>
                      )}
                    </>
                  );
                })()}
              </div>
            </FormGroup>
          </Column>
        </Row>
        <Row className={styles.row}>
          <Column sm={1}>
            <span className={styles.columnLabel}>{t('secondaryDiagnosis', 'Secondary diagnosis')}</span>
          </Column>
          <Column sm={3}>
            <FormGroup legendText={t('searchForSecondaryDiagnosis', 'Search for a secondary diagnosis')}>
              <DiagnosisSearch
                name="secondaryDiagnosisSearch"
                control={control}
                labelText={t('enterSecondaryDiagnoses', 'Enter Secondary diagnoses')}
                placeholder={t('secondaryDiagnosisInputPlaceholder', 'Choose a secondary diagnosis')}
                handleSearch={handleSearch}
              />
              <div>
                {(() => {
                  if (!getValues('secondaryDiagnosisSearch')) return null;
                  if (loadingSecondary)
                    return (
                      <>
                        <SkeletonText className={styles.skeleton} />
                        <SkeletonText className={styles.skeleton} />
                        <SkeletonText className={styles.skeleton} />
                        <SkeletonText className={styles.skeleton} />
                        <SkeletonText className={styles.skeleton} />
                      </>
                    );
                  if (!loadingSecondary && searchSecondaryResults && searchSecondaryResults.length > 0)
                    return (
                      <ul className={styles.diagnosisList}>
                        {searchSecondaryResults.map((diagnosis, index) => (
                          <li
                            role="menuitem"
                            className={styles.diagnosis}
                            key={index}
                            onClick={() => handleAddDiagnosis(diagnosis, 'secondaryDiagnosisSearch')}
                          >
                            {diagnosis.display}
                          </li>
                        ))}
                      </ul>
                    );
                  return (
                    <Tile light={isTablet} className={styles.emptyResults}>
                      <span>
                        {t('noMatchingDiagnoses', 'No diagnoses found matching')}{' '}
                        <strong>"{watch('secondaryDiagnosisSearch')}"</strong>
                      </span>
                    </Tile>
                  );
                })()}
              </div>
            </FormGroup>
          </Column>
        </Row>
        <Row className={styles.row}>
          <Column sm={1}>
            <span className={styles.columnLabel}>{t('note', 'Note')}</span>
          </Column>
          <Column sm={3}>
            <Controller
              name="clinicalNote"
              control={control}
              render={({ field: { onChange, onBlur, value } }) => (
                <TextArea
                  id="additionalNote"
                  light={isTablet}
                  rows={rows}
                  labelText={t('clinicalNoteLabel', 'Write your notes')}
                  placeholder={t('clinicalNotePlaceholder', 'Write any notes here')}
                  value={value}
                  onBlur={onBlur}
                  onChange={(event) => {
                    onChange(event);
                    const textareaLineHeight = 24; // This is the default line height for Carbon's TextArea component
                    const newRows = Math.ceil(event.target.scrollHeight / textareaLineHeight);
                    setRows(newRows);
                  }}
                />
              )}
            />
          </Column>
        </Row>
        <Row className={styles.row}>
          <Column sm={1}>
            <span className={styles.columnLabel}>{t('image', 'Image')}</span>
          </Column>
          <Column sm={3}>
            <FormGroup legendText={t('addImageToVisit', 'Add an image to this visit')}>
              <p className={styles.imgUploadHelperText}>
                {t('imageUploadHelperText', "Upload an image or use this device's camera to capture an image")}
              </p>
              <Button
                style={{ marginTop: '1rem' }}
                kind={isTablet ? 'ghost' : 'tertiary'}
                onClick={() => {}}
                renderIcon={(props) => <Add size={16} {...props} />}
              >
                {t('addImage', 'Add image')}
              </Button>
            </FormGroup>
          </Column>
        </Row>
      </Stack>
      <ButtonSet className={isTablet ? styles.tablet : styles.desktop}>
        <Button className={styles.button} kind="secondary" onClick={() => closeWorkspace()}>
          {t('discard', 'Discard')}
        </Button>
        <Button
          className={styles.button}
          kind="primary"
          onClick={handleSubmit}
          disabled={isHandlingSubmit}
          type="submit"
        >
          {t('saveAndClose', 'Save and close')}
        </Button>
      </ButtonSet>
    </Form>
  );
};

export default VisitNotesForm;

function DiagnosisSearch({ name, control, labelText, placeholder, handleSearch, error }: DiagnosisSearchProps) {
  const isTablet = useLayoutType() === 'tablet';
  const inputRef = useRef(null);

  const searchInputFocus = () => {
    inputRef.current.focus();
  };

  useEffect(() => {
    if (error) {
      searchInputFocus();
    }
  }, [error]);

  return (
    <Controller
      name={name}
      control={control}
      render={({ field: { value, onChange, onBlur }, fieldState }) => (
        <>
          <Search
            ref={inputRef}
            size={isTablet ? 'lg' : 'md'}
            light={isTablet}
            id={name}
            labelText={labelText}
            className={error && styles.diagnosisErrorOutline}
            placeholder={placeholder}
            renderIcon={error && <WarningFilled fill="red" />}
            onChange={(e) => {
              onChange(e);
              handleSearch(name);
            }}
            value={value}
            onBlur={onBlur}
          />
          <p className={styles.errorMessage}>{fieldState?.error?.message}</p>
        </>
      )}
    />
  );
}

interface DiagnosisSearchProps {
  name: 'noteDate' | 'primaryDiagnosisSearch' | 'secondaryDiagnosisSearch' | 'clinicalNote';
  labelText: string;
  placeholder: string;
  control: Control<VisitNotesFormData>;
  handleSearch: (fieldName) => void;
  error?: Object;
}
