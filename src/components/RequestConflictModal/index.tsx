import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { RequestConflictInfo } from '@server/interfaces/api/requestInterfaces';
import type {
  ServiceCommonServer,
  ServiceCommonServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestConflictModal', {
  title: 'Resolve Request Conflict',
  description:
    'These requests ask for different settings on the same server. Approving this request gives the other pending requests its settings, so they all end up with the same ones. Requests that were already approved keep the settings they were sent with.',
  thisrequest: 'This request',
  requestnumber: 'Request #{id}',
  defaultvalue: 'Default',
  profile: 'Quality Profile',
  rootfolder: 'Root Folder',
  languageprofile: 'Language Profile',
  seasons: 'Shared seasons: {seasons}',
  usesettings: 'Use These Settings',
  failedresolve: 'Something went wrong while resolving the conflict.',
});

interface RequestConflictModalProps {
  request: MediaRequest;
  conflicts: RequestConflictInfo[];
  onCancel: () => void;
  onResolved: () => void;
}

type Settings = Pick<
  MediaRequest,
  'profileId' | 'rootFolder' | 'languageProfileId'
>;

const RequestConflictModal = ({
  request,
  conflicts,
  onCancel,
  onResolved,
}: RequestConflictModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isResolving, setIsResolving] = useState(false);
  const service = request.type === 'movie' ? 'radarr' : 'sonarr';

  const { data: servers } = useSWR<ServiceCommonServer[]>(
    `/api/v1/service/${service}`
  );
  // Conflicts are always on the same server, which is the default one when the
  // request did not pick any
  const serverId =
    request.serverId != null && request.serverId >= 0
      ? request.serverId
      : servers?.find(
          (server) => server.isDefault && server.is4k === request.is4k
        )?.id;
  const { data: details } = useSWR<ServiceCommonServerWithDetails>(
    serverId !== undefined ? `/api/v1/service/${service}/${serverId}` : null
  );

  // An unpicked value takes the server default, which for anime isn't the one
  // listed, so it shows "default" rather than guess
  const describe = (settings: Settings) => ({
    profile:
      settings.profileId == null
        ? intl.formatMessage(messages.defaultvalue)
        : (details?.profiles.find(
            (profile) => profile.id === settings.profileId
          )?.name ?? ''),
    rootFolder:
      settings.rootFolder || intl.formatMessage(messages.defaultvalue),
    languageProfile:
      settings.languageProfileId == null
        ? intl.formatMessage(messages.defaultvalue)
        : (details?.languageProfiles?.find(
            (profile) => profile.id === settings.languageProfileId
          )?.name ?? ''),
  });

  const columns = [
    {
      key: 'this',
      title: intl.formatMessage(messages.thisrequest),
      subTitle: request.requestedBy.displayName,
      settings: describe(request),
    },
    ...conflicts.map(({ request: other, seasons }) => ({
      key: `request-${other.id}`,
      title: intl.formatMessage(messages.requestnumber, { id: other.id }),
      subTitle: other.requestedBy.displayName,
      seasons,
      settings: describe(other),
    })),
  ];

  const rows = [
    {
      key: 'profile' as const,
      label: intl.formatMessage(messages.profile),
    },
    {
      key: 'rootFolder' as const,
      label: intl.formatMessage(messages.rootfolder),
    },
    ...(request.type === 'tv'
      ? [
          {
            key: 'languageProfile' as const,
            label: intl.formatMessage(messages.languageprofile),
          },
        ]
      : []),
  ];

  const resolve = async () => {
    setIsResolving(true);
    try {
      await axios.post(`/api/v1/request/${request.id}/resolve`);
      onResolved();
    } catch {
      addToast(intl.formatMessage(messages.failedresolve), {
        autoDismiss: true,
        appearance: 'error',
      });
      setIsResolving(false);
    }
  };

  return (
    <Modal
      title={intl.formatMessage(messages.title)}
      okText={intl.formatMessage(messages.usesettings)}
      okButtonType="primary"
      onOk={resolve}
      onCancel={onCancel}
      loading={isResolving || !details}
      okDisabled={isResolving}
      backgroundClickable={!isResolving}
    >
      <p className="mb-4 text-sm text-gray-300">
        {intl.formatMessage(messages.description)}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="py-2 pr-4" />
              {columns.map((column) => (
                <th key={column.key} className="px-2 py-2 align-bottom">
                  <div className="font-semibold text-gray-100">
                    {column.title}
                  </div>
                  <div className="text-xs font-normal text-gray-400">
                    {column.subTitle}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {rows.map((row) => {
              const values = columns.map((column) => column.settings[row.key]);
              const differs = values.some((value) => value !== values[0]);

              return (
                <tr key={row.key}>
                  <th className="py-2 pr-4 font-medium text-gray-300">
                    {row.label}
                  </th>
                  {values.map((value, index) => (
                    <td
                      key={columns[index].key}
                      className={`px-2 py-2 ${
                        differs && index > 0
                          ? 'text-yellow-400'
                          : 'text-gray-200'
                      }`}
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {conflicts.some(({ seasons }) => seasons?.length) && (
        <ul className="mt-3 space-y-1 text-xs text-gray-400">
          {conflicts
            .filter(({ seasons }) => seasons?.length)
            .map(({ request: other, seasons }) => (
              <li key={other.id}>
                {intl.formatMessage(messages.requestnumber, { id: other.id })}
                {': '}
                {intl.formatMessage(messages.seasons, {
                  seasons: seasons?.join(', '),
                })}
              </li>
            ))}
        </ul>
      )}
    </Modal>
  );
};

export default RequestConflictModal;
