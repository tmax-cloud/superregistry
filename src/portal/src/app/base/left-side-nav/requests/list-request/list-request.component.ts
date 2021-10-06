// Copyright (c) 2017 VMware, Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import {forkJoin, of, Subscription} from "rxjs";
import {Component, EventEmitter, OnDestroy, Output} from "@angular/core";
import {Router} from "@angular/router";
import {ProjectService, State} from "../../../../shared/services";
import {TranslateService} from "@ngx-translate/core";
import {SessionService} from "../../../../shared/services/session.service";
import {MessageHandlerService} from "../../../../shared/services/message-handler.service";
import {SearchTriggerService} from "../../../../shared/components/global-search/search-trigger.service";
import {AppConfigService} from "../../../../services/app-config.service";
import {Project} from "../../../project/project";
import {catchError, finalize, map} from "rxjs/operators";
import {calculatePage, getSortingString} from "../../../../shared/units/utils";
import {OperationService} from "../../../../shared/components/operation/operation.service";
import {operateChanges, OperateInfo, OperationState} from "../../../../shared/components/operation/operate";
import {HttpErrorResponse} from "@angular/common/http";
import {ClrDatagridStateInterface} from '@clr/angular';
import {
    ConfirmationButtons,
    ConfirmationState,
    ConfirmationTargets,
    RoleInfo
} from "../../../../shared/entities/shared.const";
import {ConfirmationDialogService} from "../../../global-confirmation-dialog/confirmation-dialog.service";
import {errorHandler} from "../../../../shared/units/shared.utils";
import {ConfirmationMessage} from "../../../global-confirmation-dialog/confirmation-message";

@Component({
    selector: "list-request",
    templateUrl: "list-request.component.html"
})
export class ListRequestComponent implements OnDestroy {
    loading = true;
    projects: Project[] = [];
    filteredType = 0; // All projects
    searchKeyword = "";
    selectedRow: Project[] = [];

    @Output() addRequest = new EventEmitter<void>();

    roleInfo = RoleInfo;
    currentPage = 1;
    totalCount = 0;
    pageSize = 15;
    currentState: State;
    subscription: Subscription;
    projectTypeMap: any = {
        0: "PROJECT.PROJECT",
        1: "PROJECT.PROXY_CACHE"
    };
    state: ClrDatagridStateInterface;

    constructor(
        private session: SessionService,
        private appConfigService: AppConfigService,
        private router: Router,
        private searchTrigger: SearchTriggerService,
        private proService: ProjectService,
        private msgHandler: MessageHandlerService,
        private translate: TranslateService,
        private deletionDialogService: ConfirmationDialogService,
        private operationService: OperationService,
        private translateService: TranslateService) {
        this.subscription = deletionDialogService.confirmationConfirm$.subscribe(message => {
            if (message &&
                message.state === ConfirmationState.CONFIRMED &&
                message.source === ConfirmationTargets.PROJECT) {
                this.delProjects(message.data);
            }
        });
    }

    get projectCreationRestriction(): boolean {
        let account = this.session.getCurrentUser();
        if (account) {
            switch (this.appConfigService.getConfig().project_creation_restriction) {
                case "adminonly":
                    return (account.has_admin_role);
                case "everyone":
                    return true;
            }
        }
        return false;
    }

    get withChartMuseum(): boolean {
        return this.appConfigService.getConfig().with_chartmuseum;
    }

    public get isSystemAdmin(): boolean {
        let account = this.session.getCurrentUser();
        return account != null && account.has_admin_role;
    }

    public get canDelete(): boolean {
        if (!this.selectedRow.length) {
            return false;
        }

        return this.isSystemAdmin || this.selectedRow.every((pro: Project) => pro.current_user_role_id === 1);
    }

    ngOnDestroy(): void {
        if (this.subscription) {
            this.subscription.unsubscribe();
        }
    }

    addNewProject(): void {
        this.addRequest.emit();
    }

    goToLink(proId: number): void {
        this.searchTrigger.closeSearch(true);

        let linkUrl = ["harbor", "projects", proId];
        this.router.navigate(linkUrl);
    }

    clrLoad(state: ClrDatagridStateInterface) {
        if (!state || !state.page) {
            return;
        }
        this.state = state;
        this.pageSize = state.page.size;
        this.selectedRow = [];

        // Keep state for future filtering and sorting
        this.currentState = state;

        let pageNumber: number = calculatePage(state);
        if (pageNumber <= 0) {
            pageNumber = 1;
        }

        this.loading = true;

        let passInFilteredType: number = undefined;
        if (this.filteredType > 0) {
            passInFilteredType = this.filteredType - 1;
        }
        this.proService.listProjects(this.searchKeyword, passInFilteredType, pageNumber, this.pageSize, getSortingString(state))
            .pipe(finalize(() => {
                this.loading = false;
            }))
            .subscribe(response => {
                // Get total count
                if (response.headers) {
                    let xHeader: string = response.headers.get("X-Total-Count");
                    if (xHeader) {
                        this.totalCount = parseInt(xHeader, 0);
                    }
                }

                this.projects = response.body as Project[];
            }, error => {
                this.msgHandler.handleError(error);
            });
    }

    newReplicationRule(p: Project) {
        if (p) {
            this.router.navigateByUrl(`/harbor/projects/${p.project_id}/replications?is_create=true`);
        }
    }

    deleteProjects(p: Project[]) {
        let nameArr: string[] = [];
        if (p && p.length) {
            p.forEach(data => {
                nameArr.push(data.name);
            });
            let deletionMessage = new ConfirmationMessage(
                "PROJECT.DELETION_TITLE",
                "PROJECT.DELETION_SUMMARY",
                nameArr.join(","),
                p,
                ConfirmationTargets.PROJECT,
                ConfirmationButtons.DELETE_CANCEL
            );
            this.deletionDialogService.openComfirmDialog(deletionMessage);
        }
    }

    delProjects(projects: Project[]) {
        let observableLists: any[] = [];
        if (projects && projects.length) {
            projects.forEach(data => {
                observableLists.push(this.delOperate(data));
            });
            forkJoin(...observableLists).subscribe(resArr => {
                let error;
                if (resArr && resArr.length) {
                    resArr.forEach(item => {
                        if (item instanceof HttpErrorResponse) {
                            error = errorHandler(item);
                        }
                    });
                }
                if (error) {
                    this.msgHandler.handleError(error);
                } else {
                    this.translate.get("BATCH.DELETED_SUCCESS").subscribe(res => {
                        this.msgHandler.showSuccess(res);
                    });
                }
                let st: State = this.getStateAfterDeletion();
                this.selectedRow = [];
                if (!st) {
                    this.refresh();
                } else {
                    this.clrLoad(st);
                }
            });
        }
    }

    delOperate(project: Project) {
        // init operation info
        let operMessage = new OperateInfo();
        operMessage.name = 'OPERATION.DELETE_PROJECT';
        operMessage.data.id = project.project_id;
        operMessage.state = OperationState.progressing;
        operMessage.data.name = project.name;
        this.operationService.publishInfo(operMessage);
        return this.proService.deleteProject(project.project_id)
            .pipe(map(
                () => {
                    operateChanges(operMessage, OperationState.success);
                }), catchError(
                error => {
                    const message = errorHandler(error);
                    this.translateService.get(message).subscribe(res => {
                        operateChanges(operMessage, OperationState.failure, res);
                    });
                    return of(error);
                }));
    }

    refresh(): void {
        this.currentPage = 1;
        this.filteredType = 0;
        this.searchKeyword = "";

        this.reload();
    }

    doFilterProject(filter: number): void {
        this.currentPage = 1;
        this.filteredType = filter;
        this.reload();
    }

    doSearchProject(proName: string): void {
        this.currentPage = 1;
        this.searchKeyword = proName;
        this.reload();
    }

    reload(): void {
        let st: State = this.currentState;
        if (!st) {
            st = {
                page: {}
            };
        }
        st.page.from = 0;
        st.page.to = this.pageSize - 1;
        st.page.size = this.pageSize;

        this.clrLoad(st);
    }

    getStateAfterDeletion(): State {
        let total: number = this.totalCount - this.selectedRow.length;
        if (total <= 0) {
            return null;
        }

        let totalPages: number = Math.ceil(total / this.pageSize);
        let targetPageNumber: number = this.currentPage;

        if (this.currentPage > totalPages) {
            targetPageNumber = totalPages; // Should == currentPage -1
        }

        let st: State = this.currentState;
        if (!st) {
            st = {page: {}};
        }
        st.page.size = this.pageSize;
        st.page.from = (targetPageNumber - 1) * this.pageSize;
        st.page.to = targetPageNumber * this.pageSize - 1;

        return st;
    }

}